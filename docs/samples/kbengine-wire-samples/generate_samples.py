#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KBEngine wire-protocol test-vector generator (PA-001).

All frames are SYNTHETIC: byte layouts are derived from KBEngine source forensics
(docs/kbengine-wire-protocol.md, engine base bf1a9cd6, v2.5.10), not captured
from a live server. Numeric message IDs used here come from the engine's real
static table kbe/res/server/messages_fixed_defaults.xml; ids not present in the
static table are engine-assigned at runtime and marked TODO.

Wire rules encoded here (source refs = kbe/src paths at bf1a9cd6):
  * frame  = u16LE msgID [+ u16LE payloadLen [+ u32LE extLen]] + payload
    - fixed-length messages carry no length field (message_handler.cpp:155-171)
    - variable-length: len = payload size, id/len header excluded
      (bundle.cpp:346-347)
    - payload >= 65535: u16 len field = 65535, followed by u32 real length
      (bundle.cpp:358-368, packet_reader.cpp:116-118,130-146)
  * scalars little-endian (memorystream_converter.h:44-48, platform.h:128-136)
  * STRING = UTF-8 bytes + NUL terminator, no length prefix
    (memorystream.h:239-247, datatype.cpp:1050-1062)
  * UNICODE/BLOB/PYTHON = u32LE byte length + raw bytes
    (memorystream.h:543-565, datatype.cpp:1129-1143,1225-1230,1448-1463)
  * encrypted external channel: u16LE encryptedLen + u8 padSize + Blowfish
    ciphertext, padded to 8-byte blocks (encryption_filter.cpp:56-66)

Outputs land next to this file. Rerun: python3 generate_samples.py
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def u16(v):
    return struct.pack("<H", v)


def u32(v):
    return struct.pack("<I", v)


def i8(v):
    return struct.pack("<b", v)


def f32(v):
    return struct.pack("<f", v)


def kbe_string(s):
    """KBEngine STRING: UTF-8 + NUL terminator (memorystream.h:239-247)."""
    return s.encode("utf-8") + b"\x00"


def kbe_blob(b):
    """KBEngine BLOB / UNICODE / PYTHON payload: u32 length + bytes."""
    return u32(len(b)) + b


def frame_fixed(msg_id):
    """Fixed-length message: no length field on the wire."""
    return u16(msg_id)


def frame_variable(msg_id, payload):
    return u16(msg_id) + u16(len(payload)) + payload


def frame_extended(msg_id, payload):
    """payload >= 65535 (bundle.cpp:358-368)."""
    return u16(msg_id) + u16(65535) + u32(len(payload)) + payload


def blowfish_frame(key, plaintext):
    """External-channel encrypted packet (encryption_filter.cpp:56-66):
    u16 encryptedLen(=plaintext+1) + u8 padSize + ciphertext."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    pad = (-len(plaintext)) % 8
    if pad == 0:
        pad = 8  # engine always pads so decrypt can always strip (padSize 1..8)
    padded = plaintext + bytes(pad)
    enc = Cipher(algorithms.Blowfish(key), modes.ECB()).encryptor()
    ct = enc.update(padded) + enc.finalize()
    return u16(len(padded) + 1) + bytes([pad]) + ct


def write(name, data, note=""):
    path = os.path.join(HERE, name)
    with open(path, "wb") as f:
        f.write(data)
    print(f"{name}: {len(data)} bytes  {note}")
    print("  " + data[:64].hex(" "))
    return path


def main():
    made = []

    # ---- sample 01: fixed-length, zero-arg message --------------------
    # Loginapp::importClientMessages, id=5, fixed, args0
    # (messages_fixed_defaults.xml:72-75, loginapp_interface.h:32-33)
    made.append(write(
        "sample-01-fixed-noargs.bin",
        frame_fixed(5),
        "Loginapp::importClientMessages (fixed, args0)",
    ))

    # ---- sample 02: variable-length message ---------------------------
    # Loginapp::login id=3 (messages_fixed_defaults.xml:58-65)
    # body per clientobjectbase.cpp:604-636:
    #   i8 clientType + blob clientDatas + string name + string password
    #   + string entityDef-md5-digest
    body = (
        i8(1)
        + kbe_blob(b"\x00\x01")
        + kbe_string("player1")
        + kbe_string("pwd123")
        + kbe_string("BED58F95AE8F4B0AA0A3E1B9DUMMYDG")
    )
    made.append(write(
        "sample-02-variable-login.bin",
        frame_variable(3, body),
        "Loginapp::login (variable)",
    ))

    # ---- sample 03: extended-length message ---------------------------
    # u16 len field = 65535, then u32 real length (bundle.cpp:358-368)
    big_payload = bytes([0xA5]) * 70000
    made.append(write(
        "sample-03-extended-length.bin",
        frame_extended(518, big_payload),
        "onImportClientMessages-style frame, 70000-byte payload",
    ))

    # ---- sample 04: onImportClientMessages response -------------------
    # id=518 (messages_fixed_defaults.xml:303-309), variable
    # body per loginapp.cpp:1471-1505 / kbengine.js:3841-3863:
    #   u16 count + count * (u16 id, i16 msgLen, string name,
    #                        i8 argsType, u8 argsize, u8[argoutsize])
    entry = u16(3) + struct.pack("<h", -1) + kbe_string("Loginapp_login") + i8(-1) + b"\x00"
    body = u16(1) + entry
    made.append(write(
        "sample-04-import-client-messages.bin",
        frame_variable(518, body),
        "onImportClientMessages, 1 entry",
    ))

    # ---- sample 05: string / unicode / blob / vector3 encodings -------
    body = (
        kbe_string("abc")                       # STRING: 61 62 63 00
        + kbe_blob("你好".encode("utf-8"))      # UNICODE: u32 + UTF-8
        + kbe_blob(b"\xde\xad\xbe\xef")         # BLOB
        + f32(1.0) + f32(2.0) + f32(3.0)        # VECTOR3: 3 x f32 LE
    )
    made.append(write(
        "sample-05-type-encodings.bin",
        frame_variable(518, body),
        "STRING/UNICODE/BLOB/VECTOR3 payload samples",
    ))

    # ---- sample 06: onLoginSuccessfully (server -> client) ------------
    # id=502, fixed args STRING STRING UINT16 UINT8_ARRAY
    # (messages_fixed_defaults.xml:170-177, clientobjectbase.cpp:690-708)
    body = (
        kbe_string("player1")
        + kbe_string("127.0.0.1")
        + u16(20015)
        + kbe_blob(b"\x01\x02")
    )
    made.append(write(
        "sample-06-on-login-successfully.bin",
        frame_variable(502, body),
        "Client::onLoginSuccessfully",
    ))

    # ---- sample 07: Blowfish-encrypted external-channel frame ---------
    # framing per encryption_filter.cpp:56-66; key = client-supplied 56-byte
    # (448-bit) key via hello blob (clientapp.cpp:405-411)
    key = bytes(range(56))
    inner = frame_fixed(5)
    made.append(write(
        "sample-07-blowfish-frame.bin",
        blowfish_frame(key, inner),
        "u16 encLen + u8 padSize + Blowfish-ECB(importClientMessages frame)",
    ))

    # ---- sample 08: full PCAP of a synthetic login flow ---------------
    # loginapp TCP flow: hello -> onHelloCB -> importClientMessages ->
    # onImportClientMessages -> login -> onLoginSuccessfully.
    # Network headers (Eth/IP/TCP) are fabricated; only the KBEngine frames
    # follow the forensics above.
    hello_body = (
        kbe_string("2.5.10")            # verInfo
        + kbe_string("2.5.10")          # scriptVersion
        + kbe_blob(b"")                 # empty encrypt key -> plaintext channel
    )
    c2s_hello = frame_variable(4, hello_body)  # Loginapp::hello id=4

    # onHelloCB id=521 (fixed xml:325-328); variable-length body:
    # string serverVersion + string scriptVersion
    # + string messagesDigest + string entityDefDigest + i32 componentType
    # (loginapp.cpp:1361-1377)
    s2c_hello_cb = frame_variable(
        521,
        kbe_string("2.5.10")
        + kbe_string("2.5.10")
        + kbe_string("d41d8cd98f00b204e9800998ecf8427e")
        + kbe_string("BED58F95AE8F4B0AA0A3E1B9DUMMYDG")
        + struct.pack("<i", 4),  # LOGINAPP_TYPE
    )

    c2s_import = frame_fixed(5)

    entry_login = u16(3) + struct.pack("<h", -1) + kbe_string("Loginapp_login") + i8(-1) + b"\x00"
    entry_hello = u16(4) + struct.pack("<h", -1) + kbe_string("Loginapp_hello") + i8(-1) + b"\x00"
    s2c_import = frame_variable(
        518,
        u16(2) + entry_hello + entry_login,
    )

    c2s_login = made[1].split(b"", 1)[0] if False else frame_variable(3, body)

    login_ok = frame_variable(
        502,
        kbe_string("player1") + kbe_string("127.0.0.1") + u16(20015) + kbe_blob(b"\x01\x02"),
    )

    segments = [
        (1001, 2001, c2s_hello),      # client -> loginapp: hello
        (2001, 1001, s2c_hello_cb),   # loginapp -> client: onHelloCB
        (1001, 2001, c2s_import),     # client -> loginapp: importClientMessages
        (2001, 1001, s2c_import),     # loginapp -> client: onImportClientMessages
        (1001, 2001, c2s_login),      # client -> loginapp: login
        (2001, 1001, login_ok),       # loginapp -> client: onLoginSuccessfully
    ]
    pcap_path = os.path.join(HERE, "kbengine-login-flow.pcap")
    write_pcap(pcap_path, segments)
    print(f"kbengine-login-flow.pcap written ({len(segments)} KBEngine frames)")

    return 0


def write_pcap(path, segments):
    """Minimal single-TCP-stream pcap. seq numbers fabricated per direction."""
    def ipv4(ip):
        return bytes(int(x) for x in ip.split("."))

    eth = bytes.fromhex("02001a4b9c01") + bytes.fromhex("02001a4b9c02") + b"\x08\x00"
    src, dst = ipv4("192.168.1.50"), ipv4("192.168.1.10")

    seq = {1001: 1000, 2001: 5000}
    ack = {1001: 5000, 2001: 1000}
    records = []

    def push(seg_id, data):
        seq[seg_id] += len(data)
        ack[seg_id] = seq[2001 if seg_id == 1001 else 1001]

    for a, b, payload in segments:
        # split into <=1400-byte wire chunks like a real TCP stream
        off = 0
        while off < len(payload):
            chunk = payload[off:off + 1400]
            off += len(chunk)

            tcp = struct.pack(">HHIIBBHHH",
                              a, b, seq[a], ack[b], 5 << 4, 0x18, 8192, 0, 0)
            tcp_total = 20 + len(chunk)
            ip = struct.pack(">BBHHHBBH4s4s",
                             0x45, 0, 20 + tcp_total, 0x1234, 0x4000, 64, 6, 0, src, dst)
            # IP checksum
            s = 0
            for i in range(0, len(ip), 2):
                s += (ip[i] << 8) | ip[i + 1]
            while s >> 16:
                s = (s & 0xFFFF) + (s >> 16)
            ip = ip[:10] + struct.pack(">H", (~s) & 0xFFFF) + ip[12:]
            # TCP checksum (with pseudo header)
            pseudo = src + dst + struct.pack(">BBH", 0, 6, tcp_total)
            t = pseudo + tcp + chunk
            if len(t) % 2:
                t += b"\x00"
            s = 0
            for i in range(0, len(t), 2):
                s += (t[i] << 8) | t[i + 1]
            while s >> 16:
                s = (s & 0xFFFF) + (s >> 16)
            tcp = tcp[:16] + struct.pack(">H", (~s) & 0xFFFF) + tcp[18:]

            packet = eth + ip + tcp + chunk
            sec, usec = 1762400000 + len(records), 0
            records.append(struct.pack("<IIII", sec, usec, len(packet), len(packet)) + packet)
            push(a, chunk)

    with open(path, "wb") as f:
        f.write(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for r in records:
            f.write(r)


if __name__ == "__main__":
    sys.exit(main())
