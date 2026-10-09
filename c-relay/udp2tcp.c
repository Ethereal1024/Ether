/*
 * udp2tcp - a transparent datagram bridge for `adb reverse` tunnels.
 *
 * Why this exists
 * ---------------
 * `adb forward` / `adb reverse` can only carry TCP (the adb client's socket-spec
 * parser rejects "udp:PORT" with "unknown socket specification").  Sunshine and
 * Moonlight speak their video / audio / control channels over UDP (RTP + FEC,
 * ENet), so a plain `adb reverse` cannot carry a GameStream session.
 *
 * This program is the missing piece: it carries UDP datagrams over a TCP
 * connection while *preserving datagram boundaries*, so neither Sunshine nor
 * Moonlight needs to be modified at all.  It is deliberately generic - it does
 * not know anything about GameStream/RTSP/ping-pong payloads.
 *
 * Topology (everything on loopback, only the adb USB link in between):
 *
 *   Moonlight --UDP 127.0.0.1:47998--> [udp2tcp --device]   (on the tablet)
 *                                          | TCP 127.0.0.1:57998
 *                                    (adbd reverse tunnel, over USB)
 *                                          v
 *                              [udp2tcp --host]  (on the PC)
 *                                          | UDP 127.0.0.1:47998
 *                                          v
 *                                     Sunshine
 *
 * Every UDP flow gets its own TCP connection, so a per-flow source address is
 * preserved: the device side answers each client from the very socket the client
 * talked to, and the host side exposes a distinct UDP socket per tunnel, which is
 * exactly the "peer" Sunshine learns from the client's ping.
 *
 * Wire format:  [ u16 big-endian payload length ][ payload ]
 *
 * Queueing policy (matters for latency): each direction has a bounded userspace
 * queue.  A datagram that does not fit is dropped whole - never split, never
 * reordered.  This reproduces UDP's "drop instead of accumulate" behaviour, which
 * is what keeps Sunshine's capture->encode path from building a backlog.
 *
 * Build:
 *   host  : cc      -O2 -o udp2tcp          udp2tcp.c
 *   device: $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang \
 *             -static -O2 -o udp2tcp.aarch64 udp2tcp.c
 *
 * Self-test (no tablet required):
 *   ./udp2tcp --test
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>   /* _NSGetExecutablePath: Darwin has no /proc/self/exe */
#endif

#define MAXFRAME   65535u
#define RBUF_SIZE  (2u + MAXFRAME)
#define MAXPEER    8
#define DEFAULT_QUEUE  (256u * 1024u)
#define DEFAULT_SNDBUF (512u * 1024u)

/* ------------------------------------------------------------------ utils */

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "udp2tcp: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  exit(2);
}

static void set_nonblocking(int fd) {
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) die("fcntl(O_NONBLOCK) failed");
}

static void set_nodelay(int fd) {
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one); /* kill Nagle */
}

/* "127.0.0.1:47998" -> host + port */
static void split_hostport(const char *s, char *host, size_t hostlen, uint16_t *port) {
  const char *colon = strrchr(s, ':');
  if (!colon || colon == s || colon[1] == '\0') die("bad ADDR:PORT '%s'", s);
  size_t n = (size_t) (colon - s);
  if (n >= hostlen) die("host too long in '%s'", s);
  memcpy(host, s, n);
  host[n] = '\0';
  char *end = NULL;
  long p = strtol(colon + 1, &end, 10);
  if (!end || *end || p < 1 || p > 65535) die("bad port in '%s'", s);
  *port = (uint16_t) p;
}

static int tcp_listen(const char *host, uint16_t port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) die("bad listen host '%s'", host);
  if (bind(fd, (struct sockaddr *) &a, sizeof a) < 0) die("bind %s:%u: %s", host, port, strerror(errno));
  if (listen(fd, 16) < 0) die("listen: %s", strerror(errno));
  set_nonblocking(fd);
  return fd;
}

static int udp_bind(const char *host, uint16_t port) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  int one = 1, rcv = 1 << 20;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof rcv);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) die("bad udp host '%s'", host);
  if (bind(fd, (struct sockaddr *) &a, sizeof a) < 0) die("bind udp %s:%u: %s", host, port, strerror(errno));
  set_nonblocking(fd);
  return fd;
}

static int udp_connect_to(const char *host, uint16_t port) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  int rcv = 1 << 20;
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof rcv);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) die("bad udp host '%s'", host);
  if (connect(fd, (struct sockaddr *) &a, sizeof a) < 0) die("connect udp %s:%u: %s", host, port, strerror(errno));
  set_nonblocking(fd);
  return fd;
}

/* nonblocking TCP connect; EINPROGRESS counts as "usable" (writes will buffer) */
static int tcp_connect_nb(const char *host, uint16_t port, size_t sndbuf) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  set_nodelay(fd);
  if (sndbuf) setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &(int) { (int) sndbuf }, sizeof(int));
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) { close(fd); return -1; }
  set_nonblocking(fd);
  if (connect(fd, (struct sockaddr *) &a, sizeof a) < 0 && errno != EINPROGRESS) {
    close(fd);
    return -1;
  }
  return fd;
}

/* ------------------------------------------------- bounded tx queue (txq) */

typedef struct {
  int fd;
  unsigned char *buf;
  size_t cap, len, sent;
  unsigned long long dropped;
} txq_t;

static void txq_init(txq_t *q, size_t cap) {
  q->buf = malloc(cap);
  if (!q->buf) die("out of memory");
  q->fd = -1;
  q->cap = cap;
  q->len = q->sent = 0;
  q->dropped = 0;
}

static void txq_close(txq_t *q) {
  if (q->fd >= 0) close(q->fd);
  q->fd = -1;
  q->len = q->sent = 0;
}

/* Tail drop: a datagram that does not fit whole is discarded whole. */
static void txq_enqueue(txq_t *q, const unsigned char *p, size_t n) {
  if (q->fd < 0) return;
  if (q->sent > 0) {                      /* compact partially sent data */
    memmove(q->buf, q->buf + q->sent, q->len - q->sent);
    q->len -= q->sent;
    q->sent = 0;
  }
  if (q->len + n > q->cap) { q->dropped++; return; }
  memcpy(q->buf + q->len, p, n);
  q->len += n;
}

/*
 * "Not ready yet" is not a failure, and the spellings differ per platform: a
 * socket whose non-blocking connect() has not completed answers EAGAIN on Linux
 * but ENOTCONN on BSD/macOS (poll() reports it writable only once the connect
 * has finished).  A relay that only retried on EAGAIN dropped the queue - and
 * with it the peer - a few microseconds after creating it, which on macOS read
 * as "the tunnel comes up and then nothing ever crosses it".
 */
static int not_ready_yet(int e) {
  return e == EAGAIN || e == EWOULDBLOCK || e == EINTR || e == ENOTCONN || e == EINPROGRESS;
}

static void txq_flush(txq_t *q) {
  while (q->fd >= 0 && q->sent < q->len) {
    ssize_t w = write(q->fd, q->buf + q->sent, q->len - q->sent);
    if (w > 0) { q->sent += (size_t) w; continue; }
    if (w < 0 && not_ready_yet(errno)) return;      /* data stays queued */
    fprintf(stderr, "[relay] tcp write failed: %s\n",
            w < 0 ? strerror(errno) : "write returned 0");
    txq_close(q);
    return;
  }
  if (q->fd >= 0 && q->sent == q->len) q->len = q->sent = 0;
}

static int txq_pending(const txq_t *q) { return q->fd >= 0 && q->sent < q->len; }

/* --------------------------------------------------------------- peer/tun */

typedef struct {
  int tcp_fd;
  int udp_fd;                          /* host role: per-peer socket; device role: -1 */
  struct sockaddr_storage ua;          /* device role: client source address */
  socklen_t ualen;
  txq_t to_tcp;
  unsigned char *rbuf;
  size_t rlen;
  unsigned long long rx_dgrams, tx_dgrams;
} peer_t;

static void peer_free(peer_t *p) {
  txq_close(&p->to_tcp);
  if (p->tcp_fd >= 0) close(p->tcp_fd);
  if (p->udp_fd >= 0) close(p->udp_fd);
  p->tcp_fd = p->udp_fd = -1;
  p->rlen = 0;
}

static void frame_encode(unsigned char *dst, const unsigned char *payload, size_t n) {
  dst[0] = (unsigned char) ((n >> 8) & 0xff);
  dst[1] = (unsigned char) (n & 0xff);
  memcpy(dst + 2, payload, n);
}

/*
 * Pull all complete frames out of a peer's TCP receive buffer.
 * cb() returns 1 to keep the peer, 0 to kill it.
 */
typedef int (*frame_cb)(peer_t *p, const unsigned char *payload, size_t n, void *ctx);

static int rx_frames(peer_t *p, frame_cb cb, void *ctx) {
  while (p->rlen >= 2) {
    size_t n = ((size_t) p->rbuf[0] << 8) | (size_t) p->rbuf[1];
    if (n == 0) {                                  /* "ping" frame: ignore */
      memmove(p->rbuf, p->rbuf + 2, p->rlen - 2);
      p->rlen -= 2;
      continue;
    }
    if (p->rlen < 2 + n) break;
    if (!cb(p, p->rbuf + 2, n, ctx)) return 0;
    memmove(p->rbuf, p->rbuf + 2 + n, p->rlen - 2 - n);
    p->rlen -= 2 + n;
  }
  return 1;
}

/*
 * Drain a TCP peer: parse every complete frame, read more while it is there.
 * Returns 1 if the peer is still alive (possibly idle), 0 if it must be reaped.
 */
static int peer_pump(peer_t *p, frame_cb cb, void *ctx) {
  for (;;) {
    if (p->rlen >= 2 && !rx_frames(p, cb, ctx)) return 0;
    if (p->rlen == RBUF_SIZE) return 0;             /* desynced framing */
    ssize_t r = read(p->tcp_fd, p->rbuf + p->rlen, RBUF_SIZE - p->rlen);
    if (r > 0) { p->rlen += (size_t) r; continue; }
    if (r == 0) return 0;                           /* peer closed */
    if (not_ready_yet(errno)) return 1;             /* incl. connect in flight */
    fprintf(stderr, "[relay] tcp read failed: %s\n", strerror(errno));
    return 0;
  }
}

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double) ts.tv_sec + (double) ts.tv_nsec / 1e9;
}

typedef struct {
  int stats;
  double t0;
  unsigned long long dgrams, bytes, dropped;
  peer_t *peers;
} io_t;

static void maybe_stats(io_t *io, const char *tag) {
  double now = now_s();
  if (!io->stats || now - io->t0 < 5.0) return;
  io->t0 = now;
  fprintf(stderr, "[%s] datagrams=%llu bytes=%llu dropped=%llu\n",
          tag, io->dgrams, io->bytes, io->dropped);
  fflush(stderr);
}

/* ------------------------------------------------------------ device role */

static int dev_deliver(peer_t *p, const unsigned char *payload, size_t n, void *ctx) {
  int udp_fd = *(int *) ctx;
  if (sendto(udp_fd, payload, n, 0, (struct sockaddr *) &p->ua, p->ualen) < 0)
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ENETUNREACH;
  p->rx_dgrams++;
  return 1;
}

/*
 * device role: UDP listener on the tablet  <->  TCP connect into `adb reverse`.
 * One TCP connection per distinct UDP client address, so replies always leave
 * from the socket the client addressed.
 */
static int device_role(const char *lhost, uint16_t lport, const char *chost, uint16_t cport,
                       size_t qcap, size_t sndbuf, int stats) {
  int udp_fd = udp_bind(lhost, lport);
  fprintf(stderr, "[device] udp %s:%u  ->  tcp %s:%u (queue=%zu)\n", lhost, lport, chost, cport, qcap);

  peer_t peers[MAXPEER];
  memset(peers, 0, sizeof peers);
  for (int i = 0; i < MAXPEER; i++) {
    peers[i].tcp_fd = peers[i].udp_fd = -1;
    peers[i].rbuf = malloc(RBUF_SIZE);
    if (!peers[i].rbuf) die("out of memory");
    txq_init(&peers[i].to_tcp, qcap);
  }

  struct pollfd pfds[MAXPEER + 1];
  io_t io = { stats, now_s(), 0, 0, 0, peers };
  unsigned char *ubuf = malloc(MAXFRAME);
  unsigned char *fbuf = malloc(2 + MAXFRAME);
  if (!ubuf || !fbuf) die("out of memory");

  for (;;) {
    int n = 0;
    pfds[n].fd = udp_fd; pfds[n].events = POLLIN; pfds[n].revents = 0; n++;
    for (int i = 0; i < MAXPEER; i++) {
      if (peers[i].tcp_fd < 0) continue;
      peers[i].to_tcp.fd = peers[i].tcp_fd;
      pfds[n].fd = peers[i].tcp_fd;
      pfds[n].events = POLLIN | (txq_pending(&peers[i].to_tcp) ? POLLOUT : 0);
      pfds[n].revents = 0;
      n++;
    }
    if (poll(pfds, n, 1000) < 0) { if (errno == EINTR) continue; die("poll: %s", strerror(errno)); }

    /* --- tablet -> PC --- */
    for (;;) {
      struct sockaddr_storage src;
      socklen_t slen = sizeof src;
      ssize_t r = recvfrom(udp_fd, ubuf, MAXFRAME, 0, (struct sockaddr *) &src, &slen);
      if (r < 0) break;
      peer_t *p = NULL;
      for (int i = 0; i < MAXPEER; i++)
        if (peers[i].tcp_fd >= 0 && peers[i].ualen == slen &&
            memcmp(&peers[i].ua, &src, slen) == 0) { p = &peers[i]; break; }
      if (!p) {
        for (int i = 0; i < MAXPEER; i++) if (peers[i].tcp_fd < 0) { p = &peers[i]; break; }
        if (!p) continue;                            /* all slots busy: drop */
        int fd = tcp_connect_nb(chost, cport, sndbuf);
        if (fd < 0) continue;
        p->tcp_fd = fd;
        p->to_tcp.fd = fd;
        p->to_tcp.len = p->to_tcp.sent = 0;
        p->rlen = 0;
        memcpy(&p->ua, &src, slen);
        p->ualen = slen;
        char ip[64] = "?";
        if (src.ss_family == AF_INET) inet_ntop(AF_INET, &((struct sockaddr_in *) &src)->sin_addr, ip, sizeof ip);
        fprintf(stderr, "[device] new client %s:%u\n", ip, ntohs(((struct sockaddr_in *) &src)->sin_port));
      }
      frame_encode(fbuf, ubuf, (size_t) r);
      txq_enqueue(&p->to_tcp, fbuf, (size_t) r + 2);
      txq_flush(&p->to_tcp);                         /* keep the last packet moving */
      io.dgrams++; io.bytes += (unsigned long long) r;
    }

    /* --- PC -> tablet --- */
    for (int i = 0; i < MAXPEER; i++) {
      peer_t *p = &peers[i];
      if (p->tcp_fd < 0) continue;
      if (!peer_pump(p, dev_deliver, &udp_fd)) { peer_free(p); continue; }
      txq_flush(&p->to_tcp);
      io.dropped = p->to_tcp.dropped;
    }
    maybe_stats(&io, "device");
  }
  return 0;
}

/* -------------------------------------------------------------- host role */

static int host_deliver(peer_t *p, const unsigned char *payload, size_t n, void *ctx) {
  (void) ctx;
  ssize_t r = send(p->udp_fd, payload, n, 0);
  if (r < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ECONNREFUSED;
  p->rx_dgrams++;
  return 1;
}

/*
 * host role: TCP listener fed by `adb reverse`  <->  UDP to Sunshine.
 * Each accepted connection gets its own UDP socket, which is the peer Sunshine
 * will learn from that stream's ping.
 */
static int host_role(const char *lhost, uint16_t lport, const char *uhost, uint16_t uport,
                     size_t qcap, size_t sndbuf, int stats) {
  int listen_fd = tcp_listen(lhost, lport);
  fprintf(stderr, "[host] tcp %s:%u  ->  udp %s:%u (queue=%zu)\n", lhost, lport, uhost, uport, qcap);
  (void) sndbuf;

  peer_t peers[MAXPEER];
  memset(peers, 0, sizeof peers);
  for (int i = 0; i < MAXPEER; i++) {
    peers[i].tcp_fd = peers[i].udp_fd = -1;
    peers[i].rbuf = malloc(RBUF_SIZE);
    if (!peers[i].rbuf) die("out of memory");
    txq_init(&peers[i].to_tcp, qcap);
  }

  struct pollfd pfds[1 + 2 * MAXPEER];
  io_t io = { stats, now_s(), 0, 0, 0, peers };
  unsigned char *ubuf = malloc(MAXFRAME);
  unsigned char *fbuf = malloc(2 + MAXFRAME);
  if (!ubuf || !fbuf) die("out of memory");

  for (;;) {
    int n = 0;
    pfds[n].fd = listen_fd; pfds[n].events = POLLIN; pfds[n].revents = 0; n++;
    for (int i = 0; i < MAXPEER; i++) {
      if (peers[i].tcp_fd < 0) continue;
      peers[i].to_tcp.fd = peers[i].tcp_fd;
      pfds[n].fd = peers[i].tcp_fd;
      pfds[n].events = POLLIN | (txq_pending(&peers[i].to_tcp) ? POLLOUT : 0);
      pfds[n].revents = 0; n++;
      pfds[n].fd = peers[i].udp_fd;
      pfds[n].events = POLLIN;
      pfds[n].revents = 0; n++;
    }
    if (poll(pfds, n, 1000) < 0) { if (errno == EINTR) continue; die("poll: %s", strerror(errno)); }

    for (;;) {
      int fd = accept(listen_fd, NULL, NULL);
      if (fd < 0) break;
      set_nodelay(fd);
      if (sndbuf) setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &(int) { (int) sndbuf }, sizeof(int));
      set_nonblocking(fd);
      peer_t *p = NULL;
      for (int i = 0; i < MAXPEER; i++) if (peers[i].tcp_fd < 0) { p = &peers[i]; break; }
      if (!p) { close(fd); continue; }
      p->tcp_fd = fd;
      p->to_tcp.fd = fd;
      p->to_tcp.len = p->to_tcp.sent = 0;
      p->rlen = 0;
      p->udp_fd = udp_connect_to(uhost, uport);
      fprintf(stderr, "[host] tunnel up -> udp %s:%u\n", uhost, uport);
    }

    for (int i = 0; i < MAXPEER; i++) {
      peer_t *p = &peers[i];
      if (p->tcp_fd < 0) continue;

      /* Sunshine -> tunnel */
      for (;;) {
        ssize_t r = recv(p->udp_fd, ubuf, MAXFRAME, 0);
        if (r < 0) break;
        frame_encode(fbuf, ubuf, (size_t) r);
        txq_enqueue(&p->to_tcp, fbuf, (size_t) r + 2);
        txq_flush(&p->to_tcp);
        io.dgrams++; io.bytes += (unsigned long long) r;
      }

      /* tunnel -> Sunshine */
      if (!peer_pump(p, host_deliver, NULL)) { peer_free(p); continue; }
      txq_flush(&p->to_tcp);
    }
    maybe_stats(&io, "host");
  }
  return 0;
}

/* --------------------------------------------------------------- self-test */

/* The self-test picks its own ports fresh on every run: a fixed base collides
 * with whatever else happens to be listening (another test, a real stream) and
 * then a working bridge looks broken.  The start point is random and the search
 * wraps inside the window, so three roles never hand out the same port twice. */
#define T_PORT_LO   30000u
#define T_PORT_HI   58000u
#define T_PORT_TRIES 4000u

static uint16_t t_port_cursor;

static int port_is_free(uint16_t p) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 0;
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons(p);
  int ok = (bind(fd, (struct sockaddr *) &a, sizeof a) == 0 && listen(fd, 1) == 0);
  close(fd);
  return ok;
}

static uint16_t pick_free_tcp_port(const uint16_t *taken, int n) {
  if (t_port_cursor == 0) {
    unsigned seed = (unsigned) getpid() * 7919u + (unsigned) time(NULL);
    t_port_cursor = (uint16_t) (T_PORT_LO + seed % (T_PORT_HI - T_PORT_LO));
  }
  for (uint32_t i = 0; i < T_PORT_TRIES; i++) {
    uint32_t p = T_PORT_LO + ((uint32_t) (t_port_cursor - T_PORT_LO) + i) % (T_PORT_HI - T_PORT_LO);
    int clash = 0;
    for (int j = 0; j < n; j++) if (taken[j] == (uint16_t) p) { clash = 1; break; }
    if (clash) continue;
    if (port_is_free((uint16_t) p)) { t_port_cursor = (uint16_t) (p + 1); return (uint16_t) p; }
  }
  die("no free TCP port in %u..%u", T_PORT_LO, T_PORT_HI);
  return 0;
}

/* tiny integrity check that catches reordering/truncation/desync */
static uint32_t fnv1a(const unsigned char *d, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) { h ^= d[i]; h *= 16777619u; }
  return h;
}

/**
 * The self-test re-execs *this* binary three times (host, device, echo), so it has
 * to know its own path.  Linux answers that with /proc/self/exe.  Darwin has no
 * /proc and answers it with _NSGetExecutablePath, which may hand back a symlink —
 * exec follows it, so that is fine, but realpath() is tried first so the log line
 * names the real file.  Last resort is argv[0]: how the caller spelled it, which
 * works for the tests and for ./build.sh but not for a PATH lookup.
 *
 * Why it matters: macOS is a release platform and both ./build.sh and the interop
 * suite end in `--test`.  Dying with "cannot resolve own path" there made a
 * portable relay look broken on one of the three platforms we ship.
 */
static void own_path(char *buf, size_t n, const char *argv0) {
  ssize_t sn = readlink("/proc/self/exe", buf, n - 1);
  if (sn > 0) { buf[sn] = '\0'; return; }
#if defined(__APPLE__)
  {
    char raw[4096];
    uint32_t sz = (uint32_t) sizeof raw;
    if (_NSGetExecutablePath(raw, &sz) == 0) {
      if (realpath(raw, buf)) return;
      if (strlen(raw) < n) { strcpy(buf, raw); return; }
    }
  }
#endif
  if (argv0 && argv0[0] && realpath(argv0, buf)) return;
  die("cannot resolve own path");
}

static int test_mode(int seconds, const char *argv0) {
  uint16_t taken[3] = { 0, 0, 0 };
  uint16_t p_host_listen = pick_free_tcp_port(taken, 0); taken[0] = p_host_listen;
  uint16_t p_device_udp  = pick_free_tcp_port(taken, 1); taken[1] = p_device_udp;
  uint16_t p_echo_udp    = pick_free_tcp_port(taken, 2); taken[2] = p_echo_udp;
  char self[4096];
  own_path(self, sizeof self, argv0);

  char hs[64], hc[64], dc[64], du[64];
  snprintf(hs, sizeof hs, "127.0.0.1:%u", p_host_listen);
  snprintf(hc, sizeof hc, "127.0.0.1:%u", p_echo_udp);
  snprintf(dc, sizeof dc, "127.0.0.1:%u", p_host_listen);
  snprintf(du, sizeof du, "127.0.0.1:%u", p_device_udp);
  fprintf(stderr, "[test] ports host=%u device=%u echo=%u\n", p_host_listen, p_device_udp, p_echo_udp);

  pid_t host_pid = fork();
  if (host_pid == 0) {
    execl(self, self, "--host", "--tcp-listen", hs, "--udp-connect", hc, (char *) NULL);
    _exit(127);
  }
  pid_t dev_pid = fork();
  if (dev_pid == 0) {
    execl(self, self, "--device", "--udp-listen", du, "--tcp-connect", dc, (char *) NULL);
    _exit(127);
  }
  usleep(300 * 1000);

  /* UDP echo server standing in for Sunshine */
  pid_t echo_pid = fork();
  if (echo_pid == 0) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons(p_echo_udp);
    if (bind(fd, (struct sockaddr *) &a, sizeof a) < 0) _exit(2);
    unsigned char *b = malloc(MAXFRAME);
    for (;;) {
      struct sockaddr_storage s; socklen_t sl = sizeof s;
      ssize_t r = recvfrom(fd, b, MAXFRAME, 0, (struct sockaddr *) &s, &sl);
      if (r <= 0) continue;
      sendto(fd, b, (size_t) r, 0, (struct sockaddr *) &s, sl);
    }
  }

  /* client: Moonlight's stand-in */
  int cfd = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in dst; memset(&dst, 0, sizeof dst);
  dst.sin_family = AF_INET; dst.sin_addr.s_addr = htonl(INADDR_LOOPBACK); dst.sin_port = htons(p_device_udp);
  int rcv = 1 << 20;
  setsockopt(cfd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof rcv);
  struct timeval tv = { 3, 0 };
  setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);

  unsigned char *sb = malloc(MAXFRAME), *rb = malloc(MAXFRAME);
  unsigned rng = 12345u;
  int rc = 0;

  /* phase 1: integrity - 2000 datagrams, random sizes, verifiable content */
  const int N1 = 2000;
  int got = 0, bad = 0;
  for (int i = 0; i < N1; i++) {
    size_t n = 1 + (size_t) (rng = rng * 1103515245u + 12345u) % 1200;
    uint32_t tag = (uint32_t) i;
    memcpy(sb, &tag, 4);
    for (size_t k = 4; k < n; k++) sb[k] = (unsigned char) (rng = rng * 1103515245u + 12345u);
    uint32_t sum = fnv1a(sb, n);
    sendto(cfd, sb, n, 0, (struct sockaddr *) &dst, sizeof dst);

    ssize_t r = recv(cfd, rb, MAXFRAME, 0);
    if (r < 0) { printf("  datagram %d: TIMEOUT\n", i); rc = 1; break; }
    uint32_t rtag;
    memcpy(&rtag, rb, 4);
    if ((size_t) r != n || rtag != tag || fnv1a(rb, (size_t) r) != sum) {
      printf("  datagram %d: CORRUPT (len %zd vs %zu, tag %u vs %u)\n", i, r, n, rtag, tag);
      bad++; rc = 1; break;
    }
    got++;
  }
  printf("phase 1 integrity   : %d/%d intact, %d corrupt, order %s\n",
         got, N1, bad, rc ? "BROKEN" : "preserved");

  /* phase 2: paced round-trip goodput - keep a window outstanding so nothing drops */
  {
    const size_t FN = 1200;
    const int W = 512;
    unsigned char *win = calloc(W, FN);
    unsigned char *wr = malloc(MAXFRAME);
    int back = 0, skipped = 0;
    double t0 = now_s();
    for (int i = 0; i < W; i++) { uint32_t t = (uint32_t) i; memcpy(win + (size_t) i * FN, &t, 4); sendto(cfd, win + (size_t) i * FN, FN, 0, (struct sockaddr *) &dst, sizeof dst); }
    double deadline = t0 + (seconds > 0 ? (double) seconds : 2.0);
    while (now_s() < deadline) {
      ssize_t r = recv(cfd, wr, MAXFRAME, 0);
      if (r < 0) continue;
      if (r == (ssize_t) FN) { back++; sendto(cfd, wr, FN, 0, (struct sockaddr *) &dst, sizeof dst); }
      else skipped++;                                             /* window refill keeps up */
    }
    double dt = now_s() - t0;
    printf("phase 2 goodput     : %d x %zu B round-tripped in %.2fs -> %.2f MB/s, %.1f Mbps (%d odd-sized)\n",
           back, FN, dt, (double) back * FN / dt / 1e6, (double) back * FN * 8 / dt / 1e6, skipped);
    free(win); free(wr);
  }

  /* phase 3: overload - the queues must drop whole datagrams, never grow unbounded */
  {
    struct timeval short_to = { 0, 400 * 1000 };
    setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &short_to, sizeof short_to);
    const size_t FN = 1200;
    const int N3 = 200000;
    for (int i = 0; i < N3; i++) { uint32_t t = 0x50000000u | (uint32_t) i; memcpy(sb, &t, 4); sendto(cfd, sb, FN, 0, (struct sockaddr *) &dst, sizeof dst); }
    int drained = 0, foreign = 0, prev = -1, ordered = 1, intact = 1;
    double t0 = now_s(), tlast = t0;
    for (;;) {
      ssize_t r = recv(cfd, rb, MAXFRAME, 0);
      if (r < 0) break;
      if (r != (ssize_t) FN) { intact = 0; continue; }
      uint32_t t; memcpy(&t, rb, 4);
      if ((t & 0xff000000u) != 0x50000000u) { foreign++; continue; }   /* leftovers from phase 2 */
      int seq = (int) (t & 0x00ffffffu);
      if (seq <= prev) ordered = 0;
      prev = seq;
      drained++;
      tlast = now_s();
    }
    printf("phase 3 overload    : blasted %d, drained %d in %.2fs +%d stale (%s, %s)\n",
           N3, drained, tlast - t0, foreign, ordered ? "order preserved" : "REORDERED", intact ? "frames intact" : "FRAMING BROKEN");
    if (!ordered || !intact || drained == 0) rc = 1;
    struct timeval long_to = { 3, 0 };
    setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &long_to, sizeof long_to);
  }

  /* phase 4: post-overload integrity - the framing must not have desynced */
  {
    int late = 0, want = 50;
    for (int i = 0; i < want; i++) {
      size_t n = 400;
      uint32_t tag = 0xdead0000u + (uint32_t) i;
      memcpy(sb, &tag, 4);
      for (size_t k = 4; k < n; k++) sb[k] = (unsigned char) (k * 7 + i);
      uint32_t sum = fnv1a(sb, n);
      sendto(cfd, sb, n, 0, (struct sockaddr *) &dst, sizeof dst);
      ssize_t r = recv(cfd, rb, MAXFRAME, 0);
      if (r == (ssize_t) n && fnv1a(rb, n) == sum) late++;
      else { printf("  late check %d: expected %zu intact bytes, got %zd\n", i, n, r); rc = 1; break; }
    }
    printf("phase 4 post-flood  : %d/%d intact\n", late, want);
    if (late != want) rc = 1;
  }

  kill(echo_pid, SIGKILL); kill(dev_pid, SIGKILL); kill(host_pid, SIGKILL);
  waitpid(echo_pid, NULL, 0); waitpid(dev_pid, NULL, 0); waitpid(host_pid, NULL, 0);
  printf("%s\n", rc ? "TEST FAIL" : "TEST PASS");
  return rc;
}

/* ------------------------------------------------------- echo / bench modes */

/* Stand-in for Sunshine: echo every datagram straight back to its sender. */
static int echo_mode(const char *host, uint16_t port) {
  int fd = udp_bind(host, port);
  fprintf(stderr, "[echo] udp %s:%u\n", host, port);
  unsigned char *b = malloc(MAXFRAME);
  if (!b) die("out of memory");
  for (;;) {
    struct sockaddr_storage s;
    socklen_t sl = sizeof s;
    ssize_t r = recvfrom(fd, b, MAXFRAME, 0, (struct sockaddr *) &s, &sl);
    if (r <= 0) continue;
    sendto(fd, b, (size_t) r, 0, (struct sockaddr *) &s, sl);
  }
  return 0;
}

/*
 * Measure round-trip goodput through the whole tunnel chain.
 * A windowed sender is used so that the bounded queues never tail-drop:
 * that number is what a real Moonlight stream can expect to fit through.
 */
static int bench_mode(const char *host, uint16_t port, int seconds, size_t frame, int W) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  int rcv = 4 << 20;
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof rcv);
  struct timeval tv = { 1, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) die("bad host '%s'", host);

  unsigned char *win = calloc((size_t) W, frame);
  unsigned char *rb = malloc(MAXFRAME);
  if (!win || !rb) die("out of memory");
  for (int i = 0; i < W; i++) {
    uint32_t t = (uint32_t) i;
    memcpy(win + (size_t) i * frame, &t, 4);
    sendto(fd, win + (size_t) i * frame, frame, 0, (struct sockaddr *) &a, sizeof a);
  }
  long back = 0, odd = 0;
  double t0 = now_s(), tlast = t0;
  fprintf(stderr, "[bench] %s:%u window=%d frame=%zu for %ds\n", host, port, W, frame, seconds);
  while (now_s() - t0 < seconds) {
    ssize_t r = recv(fd, rb, MAXFRAME, 0);
    if (r < 0) {
      if (now_s() - tlast > 2.0) { fprintf(stderr, "[bench] 2s of silence, stopping\n"); break; }
      continue;
    }
    tlast = now_s();
    if (r == (ssize_t) frame) { back++; sendto(fd, rb, frame, 0, (struct sockaddr *) &a, sizeof a); }
    else odd++;
  }
  double dt = now_s() - t0;
  double mbps = dt > 0 ? (double) back * (double) frame * 8.0 / dt / 1e6 : 0;
  printf("[bench] round-trip goodput: %ld x %zu B in %.2fs -> %.1f Mbps (%.2f MB/s) payload, %ld odd-sized\n",
         back, frame, dt, mbps, mbps / 8, odd);
  free(win); free(rb);
  return 0;
}

/* ------------------------------------------------------------------ entry */

static void usage(void) {
  fprintf(stderr,
    "usage:\n"
    "  udp2tcp --device --udp-listen 127.0.0.1:47998 --tcp-connect 127.0.0.1:57998 [opts]\n"
    "  udp2tcp --host   --tcp-listen 127.0.0.1:57998 --udp-connect 127.0.0.1:47998 [opts]\n"
    "  udp2tcp --test\n"
    "opts: --queue BYTES (default %u)  --sndbuf BYTES (default %u)  --stats\n",
    DEFAULT_QUEUE, DEFAULT_SNDBUF);
  exit(2);
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  int device = 0, host = 0, test = 0, stats = 0, echo = 0, bench = 0;
  const char *udp_listen = NULL, *tcp_connect = NULL, *tcp_listen = NULL, *udp_connect = NULL;
  const char *echo_addr = NULL, *bench_addr = NULL;
  size_t queue = DEFAULT_QUEUE, sndbuf = DEFAULT_SNDBUF, frame = 1200;
  int window = 1024;
  int seconds = 3;

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--device")) device = 1;
    else if (!strcmp(argv[i], "--host")) host = 1;
    else if (!strcmp(argv[i], "--test")) test = 1;
    else if (!strcmp(argv[i], "--stats")) stats = 1;
    else if (!strcmp(argv[i], "--echo") && i + 1 < argc) { echo = 1; echo_addr = argv[++i]; }
    else if (!strcmp(argv[i], "--bench") && i + 1 < argc) { bench = 1; bench_addr = argv[++i]; }
    else if (!strcmp(argv[i], "--frame") && i + 1 < argc) frame = (size_t) strtoul(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--window") && i + 1 < argc) window = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--udp-listen") && i + 1 < argc) udp_listen = argv[++i];
    else if (!strcmp(argv[i], "--tcp-connect") && i + 1 < argc) tcp_connect = argv[++i];
    else if (!strcmp(argv[i], "--tcp-listen") && i + 1 < argc) tcp_listen = argv[++i];
    else if (!strcmp(argv[i], "--udp-connect") && i + 1 < argc) udp_connect = argv[++i];
    else if (!strcmp(argv[i], "--queue") && i + 1 < argc) queue = (size_t) strtoul(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--sndbuf") && i + 1 < argc) sndbuf = (size_t) strtoul(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atoi(argv[++i]);
    else usage();
  }
  if (test) return test_mode(seconds, argv[0]);
  if (echo) { char eh[64]; uint16_t ep; split_hostport(echo_addr, eh, sizeof eh, &ep); return echo_mode(eh, ep); }
  if (bench) { char bh[64]; uint16_t bp; split_hostport(bench_addr, bh, sizeof bh, &bp); return bench_mode(bh, bp, seconds, frame, window); }
  if (device && udp_listen && tcp_connect) {
    char lh[64], ch[64]; uint16_t lp, cp;
    split_hostport(udp_listen, lh, sizeof lh, &lp);
    split_hostport(tcp_connect, ch, sizeof ch, &cp);
    return device_role(lh, lp, ch, cp, queue, sndbuf, stats);
  }
  if (host && tcp_listen && udp_connect) {
    char lh[64], uh[64]; uint16_t lp, up;
    split_hostport(tcp_listen, lh, sizeof lh, &lp);
    split_hostport(udp_connect, uh, sizeof uh, &up);
    return host_role(lh, lp, uh, up, queue, sndbuf, stats);
  }
  usage();
  return 2;
}
