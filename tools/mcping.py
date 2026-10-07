import socket, struct, sys, json

def varint(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n: return out

def read_varint(sock):
    num = 0; shift = 0
    while True:
        b = sock.recv(1)
        if not b: raise EOFError('连接被关闭')
        num |= (b[0] & 0x7F) << shift
        if not (b[0] & 0x80): return num
        shift += 7

def ping(host, port, timeout=8):
    s = socket.create_connection((host, port), timeout=timeout); s.settimeout(timeout)
    hostb = host.encode()
    payload = b'\x00' + varint(763) + varint(len(hostb)) + hostb + struct.pack('>H', port) + varint(1)
    s.sendall(varint(len(payload)) + payload)
    s.sendall(varint(1) + b'\x00')
    _ = read_varint(s); pid = read_varint(s); ln = read_varint(s)
    data = b''
    while len(data) < ln:
        chunk = s.recv(ln - len(data))
        if not chunk: break
        data += chunk
    s.close()
    return pid, json.loads(data.decode('utf-8', 'replace'))

if len(sys.argv) >= 3:
    targets = [(sys.argv[1], int(sys.argv[2]), f'{sys.argv[1]}:{sys.argv[2]}')]
else:
    targets = [('127.0.0.1', 25565, '本地 25565')]

for host, port, label in targets:
    try:
        pid, j = ping(host, port)
        v = j.get('version', {}); p = j.get('players', {})
        if not v and not p:
            # 某些服务端在还没就绪时会回一个结构不一样的响应，原样打出来便于排查
            print(f"  ~ {label} → 响应结构异常，原文：{str(j)[:200]}")
        else:
            desc = j.get('description')
            motd = desc.get('text') if isinstance(desc, dict) else desc
            print(f"  ✔ {label} → 版本 {v.get('name')} (协议 {v.get('protocol')}) · 在线 {p.get('online')}/{p.get('max')} · MOTD {motd}")
    except Exception as e:
        print(f"  ✘ {label} → {type(e).__name__}: {e}")
