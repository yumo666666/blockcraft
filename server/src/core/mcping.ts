import net from 'node:net';

/**
 * Minecraft Server List Ping（协议层探测）。
 *
 * 为什么不直接用 RCON 的 `list`：
 *   1) RCON 依赖服务端开了 rcon，而这不一定是开着的；
 *   2) 每查一次 list，服务端日志里就会多两行 "RCON Listener/Client ... started/shutting down"，
 *      定期轮询会把真正的日志冲得很快（实测控制台里全是这些噪音）。
 * 协议探测只在 TCP 层握一次手，服务端不写日志。
 *
 * 拿不到就返回 null，调用方自己决定退化策略。
 */

export interface PingResult {
  online: number;
  max: number;
  version: string | null;
  motd: string | null;
}

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null;
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 5) return null;
  }
  return { value: value >>> 0, size };
}

/** 探测一次；任何失败都返回 null（不抛） */
export async function pingServer(host: string, port: number, timeoutMs = 2500): Promise<PingResult | null> {
  return new Promise<PingResult | null>((resolve) => {
    let done = false;
    let sock: net.Socket | null = null;
    let buf = Buffer.alloc(0);
    const finish = (r: PingResult | null): void => {
      if (done) return;
      done = true;
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    try {
      sock = net.createConnection({ host, port });
    } catch {
      resolve(null);
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const payload = Buffer.concat([
        Buffer.from([0x00]), // packet id: handshake
        writeVarint(763), // 协议号：填什么都行，服务端会用实际版本回
        writeVarint(hostBuf.length),
        hostBuf,
        (() => {
          const p = Buffer.alloc(2);
          p.writeUInt16BE(port, 0);
          return p;
        })(),
        writeVarint(1), // next state: status
      ]);
      sock?.write(Buffer.concat([writeVarint(payload.length), payload]));
      sock?.write(Buffer.concat([writeVarint(1), Buffer.from([0x00])])); // 空的状态请求
    });

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 1) return;
      const len = readVarint(buf, 0);
      if (!len) return;
      if (buf.length < len.size + len.value) return;
      const body = buf.subarray(len.size, len.size + len.value);
      const pid = readVarint(body, 0);
      if (!pid || pid.value !== 0) {
        finish(null);
        return;
      }
      const strLen = readVarint(body, pid.size);
      if (!strLen) {
        finish(null);
        return;
      }
      const jsonText = body.subarray(pid.size + strLen.size, pid.size + strLen.size + strLen.value).toString('utf8');
      try {
        const j = JSON.parse(jsonText) as {
          players?: { online?: number; max?: number };
          version?: { name?: string };
          description?: unknown;
        };
        const desc = j.description;
        let motd: string | null = null;
        if (typeof desc === 'string') motd = desc;
        else if (desc && typeof desc === 'object') {
          const o = desc as { text?: string; extra?: { text?: string }[] };
          motd = [o.text ?? '', ...(o.extra ?? []).map((e) => e.text ?? '')].join('') || null;
        }
        finish({
          online: Number(j.players?.online ?? 0),
          max: Number(j.players?.max ?? 0),
          version: j.version?.name ?? null,
          motd,
        });
      } catch {
        finish(null);
      }
    });
  });
}
