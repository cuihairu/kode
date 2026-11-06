# KBEngine Wire Protocol Specification (PA-001 Phase 0 protocol source forensics)

> Status: Phase 0 forensics output. Every conclusion carries a KBEngine
> engine-source `file:line` citation (base commit
> `bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0`, 2026-11-05, with
> `kbe/src/lib/network`, `kbe/src/lib/common`, `kbe/src/lib/entitydef`,
> `kbe/src/lib/client_lib` verified unchanged from that commit to the engine
> repo's HEAD `2f8b1a6`, so cited line numbers agree at both ends). Questions
> forensics cannot cover are uniformly marked **TODO** — nothing is invented.
> Test packets and PCAP samples: §12 (synthetic samples, byte-for-byte
> aligned with this document's rules).

---

## 1. Baseline engine version

| Item | Value | Basis |
|---|---|---|
| Engine repo | `~/workspaces/kbengine` (kbengine fork) | — |
| Forensics base commit | `bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0` (2026-11-05) | `git log -1 bf1a9cd6` |
| Engine version | 2.5.10 (`2.5.10`, reported in the `hello` handshake plaintext) | `kbe/src/lib/common/kbeversion.h:10-12` |
| Transport | TCP (default) / UDP+RUDP / KCP / WebSocket | `kbe/src/lib/network/packet_reader.h:19-24` (`PACKET_READER_TYPE_SOCKET=0 / WEBSOCKET=1 / KCP=2`) |

---

## 2. Layered model

```
Application messages (MessageHandler / EntityMethod / EntityProperty)
    │  Bundle (message aggregation, length backfill)
    ▼
Packet (≤1460B TCP / 1472B UDP, kbe/src/lib/network/common.h:81-83)
    │  PacketSender (+ optional PacketFilter: Blowfish / WebSocket)
    ▼
TCP / UDP / KCP / WebSocket socket
    │  PacketReceiver (+ optional decryption filter)
    ▼
PacketReader (one each for the server and the C++/JS/Unity clients, state-machine framing)
```

- Send-side aggregation: `Bundle::newMessage`
  (`kbe/src/lib/network/bundle.cpp:273-312`) packs multiple messages
  consecutively inside one `Bundle`, sent along the TCP stream; a single
  message may span multiple `Packet`s.
- Receive-side framing: `PacketReader::processMessages`
  (`kbe/src/lib/network/packet_reader.cpp:31-250`) loops pulling
  `msgID → msgLen → body` out of the byte stream; incomplete data suspends a
  fragment awaiting the next packet (`writeFragmentMessage`/
  `mergeFragmentMessage`, `packet_reader.cpp:253-289`).

---

## 3. Endianness and scalar encoding

- **Wire order = little-endian**. The default compile macro
  `KBENGINE_ENDIAN = KBENGINE_LITTLE_ENDIAN`
  (`kbe/src/lib/common/platform.h:128-136`) makes `EndianConvert()` a no-op
  (`kbe/src/lib/common/memorystream_converter.h:44-48`) — i.e. `MemoryStream`
  writes directly in host little-endian. Only explicitly defining
  `USE_BIG_ENDIAN` flips to big-endian (no known deployment uses it; see §13
  TODO-1).
- `MemoryStream::append<T>` calls `EndianConvert` then appends as-is
  (`kbe/src/lib/common/memorystream.h:139-143`); reads are symmetric
  (`read<T>`, the `operator>>` scalar overloads, `memorystream.h:253-317`).
- Scalar widths: `int8/uint8` 1B, `int16/uint16` 2B, `int32/uint32` 4B,
  `int64/uint64` 8B, `float` 4B, `double` 8B; `bool` is stored/read as
  `int8` (`memorystream.h:224-227,253-257`); `COMPONENT_TYPE` and
  `ENTITYCALL_TYPE` are both stored/read as `int32`
  (`memorystream.h:347-358`).
- `ENTITY_ID` = `int32` (`kbe/src/lib/common/platform.h:342`).
- `ArraySize` (the prefix of every "length-carrying array/block") = `uint32`
  (`platform.h:353`).

### 3.1 Strings and blocks

| Type | Wire format | Basis |
|---|---|---|
| STRING (protocol parameter `std::string`) | UTF-8 bytes + a **NUL terminator**, no length prefix; `append(str)` writes the `\0` (`memorystream.h:566-568`), the reader scans byte by byte until `\0` or a non-ASCII byte stops it (`memorystream.h:319-332`) | `datatype.cpp:1050-1062` (`StringType::addToStream` uses `<< s`) |
| UNICODE (EntityDef) | `u32 byte length + UTF-8 bytes` (no NUL) | `datatype.cpp:1129-1143`; `appendBlob`/`readBlob` `memorystream.h:543-565,425-441` |
| BLOB | `u32 byte length + raw bytes` | `datatype.cpp:1448-1463` |
| PYTHON / PY_DICT / PY_TUPLE / PY_LIST | `u32 length + pickle byte stream` (CPython pickle passthrough) | `datatype.cpp:1225-1242` (`script::Pickler::pickle`) |
| VECTOR3 | 3 × f32 contiguous (no prefix); `VECTOR2/VECTOR4` likewise 2/4 × f32 | `datatype.cpp:841-858,946-963` |
| ARRAY (FixedArray) | `u32 element count + per-element recursive encoding` | `datatype.cpp:1837-1856` |
| FIXED_DICT | keys encoded in declaration order, **no key names** | `datatype.cpp:2592+` (`FixedDictType::addToStreamEx`) |
| ENTITYCALL | see §13 TODO-2 (the wire format of ENTITYCALLs carried as properties was not forensically pinned byte for byte; `operator<<(ENTITYCALL_TYPE)` is int32, `memorystream.h:351-354`) | — |

Note that STRING and UNICODE are **two separate encodings**: a protocol
parameter's `std::string` is NUL-terminated (the reader stops at any
non-ASCII byte, so the first byte of a Chinese UTF-8 sequence, ≥0x80, also
truncates early, `memorystream.h:326-330`), while an EntityDef property's
UNICODE is length-prefixed. This is exactly why C-15 must distinguish two
String layouts.

---

## 4. Message frame format (core)

### 4.1 Frame structure

```
+-------------+---------------------+---------------------+---------+
| u16 msgID   | [u16 msgLen]        | [u32 extLen]        | payload |
+-------------+---------------------+---------------------+---------+
  always present    variable-length only     only when msgLen==65535
```

- `MessageID` = `uint16` (`kbe/src/lib/network/common.h:17`).
- `MessageLength` = `uint16`, `MessageLength1` = `uint32` (`common.h:21-22`);
  `NETWORK_MESSAGE_MAX_SIZE = 65535` (`common.h:91-92`).
- Length constants: `NETWORK_VARIABLE_MESSAGE = -1` (variable),
  `NETWORK_FIXED_MESSAGE = 0` (fixed, length computed at registration)
  (`common.h:111-115`).

### 4.2 Three length shapes

1. **Fixed**: `msgLen >= 0`. The wire **carries no length field**; the
   receiver looks the length up in the static table.
   `MessageHandlers::add` (`kbe/src/lib/network/message_handler.cpp:140-229`):
   a declared `msgLen == 0` is computed via `args->dataSize()`
   (`message_handler.cpp:194-196`); a parameter type containing
   `std::string` forcibly downgrades to variable
   (`message_handler.cpp:201-215`); ENTITY-class messages then
   `+= sizeof(ENTITY_ID)` (i.e. +4, `message_handler.cpp:218`).
2. **Variable**: on the wire, `u16 msgLen` = **the payload byte count,
   excluding the 2B msgID and the 2B length header itself**. The sender
   writes 0 as a placeholder then backfills, and the backfilled value
   explicitly subtracts
   `NETWORK_MESSAGE_ID_SIZE + NETWORK_MESSAGE_LENGTH_SIZE`
   (`bundle.cpp:301-308` placeholder, `bundle.cpp:346-347` subtract headers,
   `bundle.cpp:371-377` backfill); the receiver reads `>> currlen` directly
   as the body length (`packet_reader.cpp:98-119`).
3. **Extended length**: when a variable message's payload is `>= 65535`, the
   2B length field writes the sentinel `65535`, immediately followed by
   `u32 actual length` (4 bytes beyond the header). Sender
   `bundle.cpp:358-368` (`currMsgLength_ >= NETWORK_MESSAGE_MAX_SIZE` →
   write 65535 + `insert` a 4B real length); receiver `packet_reader.cpp:116-118`
   (reading 65535 sets the `NETWORK_MESSAGE_MAX_SIZE1` sentinel) →
   `packet_reader.cpp:130-167` (reads the u32; beyond
   `MemoryStream::MAX_SIZE` the channel is condemned outright).
   Note: **external server channels refuse to decode messages >65535**
   (`packet_reader.cpp:165-186`, except BOTS/CLIENT components) — extended
   length is in practice only used on internal inter-process channels and in
   the client receive direction.

### 4.3 packetAlwaysContainLength

- Default `false`: `kbe/src/lib/helper/debug_option.cpp:11`.
- The server reads `kbengine[_defaults].xml`'s `<packetAlwaysContainLength>`
  (`kbe/src/lib/server/serverconfig.cpp:132-134`); the C++ client reads
  `kbe/src/lib/client_lib/config.cpp:72-74`.
- When true, **all messages register as variable-length** (`msgLen` forced to
  `-1`, `message_handler.cpp:173-175`) — i.e. every message on the wire
  carries a u16 length field, including originally fixed ones. This is the
  direct basis for making the parser's behavior a configuration option
  rather than hard-coding "fixed means no length field".

### 4.4 Multiple messages per TCP packet

A `Bundle` can `newMessage(...)` several messages consecutively and send
once; messages butt against each other with no packet-level frame header and
self-segment by id/length; a message crossing packets is reassembled by the
receiver's fragment logic (`packet_reader.cpp:31,253-289`). `Packet` capacity
caps: TCP 1460B, UDP 1472B (`common.h:81-83`;
`GAME_PACKET_MAX_SIZE_TCP` further subtracts id+len+encryption reserves,
`common.h:95-98`).

---

## 5. Message ID allocation

### 5.1 Static fixed defaults

- Each `MessageHandlers` instance loads two XMLs at construction:
  1. `server/messages_fixed_defaults.xml` (engine built-in, `notFoundError=true`)
  2. `server/messages_fixed.xml` (project override, may be absent with
     `notFoundError=false`)
  (`kbe/src/lib/network/message_handler.cpp:40-41`;
  engine built-in table: `kbe/res/server/messages_fixed_defaults.xml`, 80
  `<id>` entries in total.)
- Parsing rule: the XML element name = `Component::messageName` (e.g.
  `Loginapp::login`), the child element `<id>` = the fixed ID
  (`kbe/src/lib/network/fixed_messages.cpp:29-74`, stored in
  `_infomap[msgname]`).
- At registration: a fixed-table hit → use the table's ID
  (`message_handler.cpp:168-171`); no hit → allocate incrementally from 1,
  **skipping IDs already occupied by the fixed table**
  (`message_handler.cpp:152-166`).

Engine built-in static table samples (real values,
`kbe/res/server/messages_fixed_defaults.xml`):

| Message | ID | Lines |
|---|---|---|
| `Loginapp::login` | 3 | xml:58-65 |
| `Loginapp::hello` | 4 | xml:67-70 |
| `Loginapp::importClientMessages` | 5 | xml:72-75 |
| `Client::onImportClientMessages` | 518 | xml:303-309 |
| `Client::onLoginSuccessfully` | 502 | xml:170-177 |
| `Client::onHelloCB` | 521 | xml:325-328 |

The JS SDK's built-in table hard-codes only the few messages above; all the
rest rely on dynamic import
(`kbe/res/sdk_templates/client/js/kbengine.js:1406-1409`).

### 5.2 Login-time dynamic import (critical: the static table does not hold on a real connection)

Message IDs absent from the fixed table are **allocated incrementally when
each server process starts** — consistent per process across restarts
(registration order is deterministic), but **not guaranteed consistent
across processes or projects**. The client must pull the message table once
each from loginapp / baseapp after login:

- Uplink `importClientMessages` (fixed, args0):
  - On loginapp: `kbe/src/server/loginapp/loginapp_interface.h:32-33`
    (exposed + fixed).
  - On baseapp: `kbe/src/server/baseapp/baseapp_interface.h:35-36`.
- Downlink `onImportClientMessages` (id=518, variable):
  - loginapp returns **all ClientInterface messages + Loginapp exposed
    messages** (`kbe/src/server/loginapp/loginapp.cpp:1416-1506`).
  - baseapp returns only **Baseapp exposed messages**
    (`kbe/src/server/baseapp/baseapp.cpp:4965-5020`).
- Per-message record wire format (`loginapp.cpp:1471-1481` write order = JS
  read order `kbengine.js:3841-3863`):

```
u16 count
count × {
  u16  msgID
  i16  msgLen        // -1=variable; >=0=fixed (including ENTITY messages' +4 semantics)
  str  msgName       // STRING: NUL-terminated, `::` already replaced with `_`
  i8   argsType      // -1=variable args / 0=fixed args
  u8   argsize
  u8[argoutsize]     // each payload field's datatype2id type ID
}
```

- Type IDs are generated by `datatype2id()` (`kbe/src/lib/server/common.h:208`).

### 5.3 Server error description import

`importServerErrorsDescr` (loginapp, fixed, args0,
`loginapp_interface.h:36-37`) → downlink `onImportServerErrorsDescr`:
`u16 count + count × (u16 id, str name, str descr)` (written at
`loginapp.cpp:1507-1536`; JS reads `kbengine.js:3451-3466`).

### 5.4 SDK import

`importClientSDK` (variable, `loginapp_interface.h:40-41`, handled at
`loginapp.cpp:1539+`): returns the generated SDK files in chunks
(`i32 remainingFiles, str fileName, i32 fileSize, blob fileDatas`; JS reads
`kbengine.js:3468-3473`).

---

## 6. The full login → protocol import → EntityDef import flow

Per the JS client (the official SDK template); the C++ client_lib semantics
agree:

1. **Establish the connection** to loginapp (TCP/WebSocket/KCP; KCP needs a
   UDP handshake first, see §10.2).
2. **hello handshake** (may happen before or after the protocol import; the
   JS sends it after the import completes). Uplink `Loginapp::hello` (id=4,
   variable): `str verInfo + str scriptVerInfo + blob encryptedKey`
   (server parses `kbe/src/lib/server/serverapp.cpp:504-539`; client sends
   `kbengine.js` `hello()`, the key logic matching
   `kbe/src/lib/client_lib/clientapp.cpp:648-664`). Version mismatch →
   `onVersionNotMatch` (`serverapp.cpp:536-537`).
3. Downlink `Client::onHelloCB` (id=521, variable):
   `str serverVersion + str scriptVersion + str messagesDigest +
   str entityDefDigest + i32 componentType`
   (`kbe/src/server/loginapp/loginapp.cpp:1361-1377`; this packet is marked
   already-encrypted and skips re-encryption, `loginapp.cpp:1374-1376`).
   The client compares the two digests to decide whether to re-import.
4. **Protocol import**: uplink `Loginapp::importClientMessages` (id=5, no
   body) (JS `kbengine.js:3487-3494`) → downlink `onImportClientMessages`
   (§5.2).
5. **Error table import**: uplink `importServerErrorsDescr` → downlink
   `onImportServerErrorsDescr` (§5.3; JS `kbengine.js:3533-3541`).
6. **Login**: uplink `Loginapp::login` (id=3, variable):
   `i8 clientType + blob clientDatas + str accountName + str password +
   str entityDefMd5Digest`
   (C++ `kbe/src/lib/client_lib/clientobjectbase.cpp:604-637`; the digest
   lets the server verify the client's def consistency; `allowEmptyDigest`
   is skipped only for BOTS, 604-627).
7. Downlink `Client::onLoginSuccessfully` (id=502, fixed: STRING STRING
   UINT16 UINT8_ARRAY): `str accountName + str baseappIP + u16 baseappTcpPort
   + blob serverDatas` (`clientobjectbase.cpp:690-708`; field types at
   `messages_fixed_defaults.xml:170-177`). Failure → `onLoginFailed` (i32
   error code + blob, `clientobjectbase.cpp:710-723`).
8. **Connection switch (loginapp → baseapp)**: the client disconnects
   loginapp and connects baseapp, first `hello` (variable:
   `str verInfo + str scriptVer + blob blowfishKey(nullable)`,
   `clientapp.cpp:399-415`) → the server answers `onHelloCB` and attaches a
   Blowfish filter per the key (`baseapp.cpp:4899-4936`).
9. **baseapp protocol import + EntityDef import**: uplink
   `Baseapp::importClientMessages` (id=207, `baseapp_interface.h:35-36`; JS
   `kbengine.js:3523-3555`) → downlink `onImportClientMessages` (§5.2,
   exposed only); then uplink `Baseapp::importClientEntityDef` (id=208,
   fixed args0, `baseapp_interface.h:39-40`).
10. Downlink `Client::onImportClientEntityDef` (variable):
    - Alias section: `u16 aliassize + aliassize × (u16 uid, str name, str
      aliasName)`; FIXED_DICT types append `u8 keysize + str moduleName +
      keysize × (str key, u16 keyUid)`; ARRAY types append `u16 element-type
      uid` (written at `baseapp.cpp:5042-5080`; JS reads
      `kbengine.js:3570-3630`).
    - Module section: per `hasClient` script module: `str name + u16 utype +
      u16 propertysize (including the 3 built-in properties
      position/direction/spaceID) + u16 clientMethodSize + u16
      baseMethodSize + u16 cellMethodSize` + per-property descriptions +
      per-method descriptions (written at `baseapp.cpp:5084-5110+`; JS reads
      `kbengine.js:3636-3699`).
    - On completion the client enters the normal game message flow (JS
      `kbengine.js:3560+`).
11. **Reconnect**: `Baseapp::reloginBaseapp` (variable):
    `str name + str password + u32 rndUUID + i32 entityID`
    (`clientobjectbase.cpp:655-670`; on success `onReloginBaseappSuccessfully`
    reads `u32 rndUUID`, 754-758).

---

## 7. Entity messages and remote method calls

- Client → server entity methods: `EntityCallAbstract::newCall_` selects the
  message per target — base methods → `Baseapp::onRemoteMethodCall`, cell
  methods → `Baseapp::onRemoteCallCellMethodFromClient`
  (`kbe/src/lib/entitydef/entitycallabstract.cpp:104-121`; declared at
  `baseapp_interface.h:170-171`), then writes `i32 entityID`
  (`entitycallabstract.cpp:120`) + parameter by parameter
  (`MethodDescription::addToStream`,
  `kbe/src/lib/entitydef/remote_entity_method.cpp:62-88`).
- Server → client entity messages: ENTITY-class messages' fixed-length
  semantics already include the +4 entityID (§4.2, `message_handler.cpp:218`).
- The field-level format of property synchronization (baseapp/cellapp →
  client) (alias ID vs utype selection, volatile position compaction
  `readPackXYZ` etc.): §13 TODO-3.

---

## 8. Encryption

External channels support Blowfish symmetric encryption:

- The client carries a random key in hello's blob field (C++ side
  `clientapp.cpp:405-411` generates the `BlowfishFilter` and calls
  `appendBlob(key)`; an empty blob = no encryption).
- After the server validates the version, if
  `g_channelExternalEncryptType > 0` and the key length is >3, it creates a
  filter with that key and attaches it to the channel (`loginapp.cpp:1380-1386`;
  `Network::createEncryptionFilter`,
  `kbe/src/lib/network/encryption_filter.h`).
- **Encrypted frame format**: `u16 encryptedLen + u8 padSize + Blowfish-ECB
  ciphertext`. Sender: plaintext is padded per block, `encryptedLen =
  plaintext length + 1`, `padSize = the padded byte count`
  (`encryption_filter.cpp:56-66`); the receiver frames and decrypts in the
  same format, restoring with `wpos -= padSize`
  (`encryption_filter.cpp:95-250`). The minimal encrypted frame requires
  `PACKET_LENGTH_SIZE + 1 + BLOCK_SIZE` bytes (`encryption_filter.cpp:139`).
- `ENCRYPTTION_WASTAGE_SIZE = 8` (encryption reserves 1B of length expansion
  + 7B of block padding, `common.h:77`) — counted into
  `GAME_PACKET_MAX_SIZE_TCP` (`common.h:95-98`).
- WebSocket channels go through RFC6455 frame filtering
  (`kbe/src/lib/network/websocket_packet_filter.*`); WSS/TLS certificate
  config `g_sslCertificate/g_sslPrivateKey` (`common.h:56-57`).
- Internal channels are not encrypted.

## 9. Compression

**No compression exists at the protocol layer.** Searching all of
`kbe/src/lib/network` for `zlib/lzo/lz4/deflate/compress` finds no
functional hits (only trace debug output). KBEngine wire-protocol message
bodies are not compressed; the parser needs no decompression layer.
**TODO-4**: if historical versions (the BigWorld lineage) once had a
compression option, this baseline engine confirms it does not exist — no
compatibility needed.

## 10. Connections and transport

### 10.1 TCP (default)

Messages self-segment per §4, no packet-level frame header; the 1460B
`Packet` cap affects only send-side fragmentation, not parsing.

### 10.2 UDP / KCP handshake

- A KCP/UDP channel's first packet must be the handshake string
  `UDP_HELLO = "62a559f3fa7748bc22f8e0766019d498"`
  (`kbe/src/lib/network/common.cpp:41-42`); the server answers
  `UDP_HELLO_ACK = "1432ad7c829170a76dd31982c3501eca" + str version +
  u32 channelId` (`kbe/src/lib/network/channel.cpp:1099-1116`).
- After the handshake the channel switches to `KCPPacketReader`
  (`channel.cpp:1111-1116`); message format thereafter is identical to TCP
  (`kcp_packet_reader.*`).

### 10.3 Connection switching

The loginapp → baseapp switch: §6 step 8; reconnect: §6 step 11. When
switching, **hello + the protocol import must be redone** (baseapp's and
loginapp's message tables are independent of each other).

---

## 11. Client MessageReader vs server PacketReader comparison

| Side | Implementation | Key differences |
|---|---|---|
| Server C++ | `kbe/src/lib/network/packet_reader.cpp:31-250` | unknown msgID → ERROR + condemn channel (73-79); external length cap check (165-186); extended-length cap `MemoryStream::MAX_SIZE` (141-163) |
| JS client | `kbe/res/sdk_templates/client/js/kbengine.js:3185-3350` (the import-time-only `Client_onImportClientMessages` path 3899-3944) | unknown msgID only errors and breaks (3207-3212); extended length test `== MESSAGE_MAX_SIZE` (3239) |
| Unity C# | `kbe/res/sdk_templates/client/unity/MessageReaderTCP.cs` (`MessageReaderBase.cs` defines the interface), `MessageReaderKCP.cs` | extended length test `>= 65535` (MessageReaderTCP.cs:109) |
| UE4 C++ | `kbe/res/sdk_templates/client/ue4/Source/KBEnginePlugins/Engine/MessageReader.cpp` | same state machine (§13 TODO-5: not compared line by line) |

All three ends share the state machine
`READ_ID → (READ_LEN → READ_LEN_EX) → READ_BODY`, supporting fragmentation at
arbitrary byte boundaries.

---

## 12. Test packets and PCAP samples

Directory `docs/samples/kbengine-wire-samples/`. **Synthetic samples**:
generated by `generate_samples.py` per this document's rules and verified by
round-trip through an independent decoder; message IDs come from the
engine's real static table (§5.1); **not real server captures**.

| File | Content | First bytes hex |
|---|---|---|
| `sample-01-fixed-noargs.bin` | the fixed no-arg message `Loginapp::importClientMessages` (id=5, no length field) | `05 00` |
| `sample-02-variable-login.bin` | variable `Loginapp::login` (id=3, len=54) | `03 00 36 00` |
| `sample-03-extended-length.bin` | extended-length message: u16=65535(`ff ff`) + u32 real length 70000(`70 11 01 00`) | `06 02 ff ff 70 11 01 00` |
| `sample-04-import-client-messages.bin` | `onImportClientMessages` (id=518), 1 protocol table entry | `06 02 17 00` |
| `sample-05-type-encodings.bin` | STRING(`61 62 63 00`)/UNICODE/BLOB/VECTOR3 encoding samples | `06 02 22 00` |
| `sample-06-on-login-successfully.bin` | `Client::onLoginSuccessfully` (id=502) | `f6 01 1a 00` |
| `sample-07-blowfish-frame.bin` | encrypted frame: `u16 encLen + u8 padSize + Blowfish-ECB` (56-byte test key; ciphertext decryptable) | `09 00 06` |
| `kbengine-login-flow.pcap` | a synthetic TCP session, 6 frames: hello→onHelloCB→importClientMessages→onImportClientMessages→login→onLoginSuccessfully (Eth/IP/TCP headers synthetic) | pcap |

Reproduce: `python3 docs/samples/kbengine-wire-samples/generate_samples.py`
(the `cryptography` dependency is only for sample 07's real Blowfish-ECB).

---

## 13. The C-15 revision checklist (the wire-format codec)

1. **The static message table assumption does not hold (most important)**.
   C-15's existing `decode_message_frame` depends on a pre-seeded message
   table; in a real connection, apart from the 5 built-in fixed ids (§5.1),
   **all message IDs are allocated incrementally at process start and
   dynamically delivered at login via `onImportClientMessages`** (§5.2).
   Revision: the message table must be modeled as three merged segments —
   "static defaults + project overrides + dynamic imports"; the
   id↔(name,msgLen,argtypes) mapping can only come from import frames, not
   static inference.
2. **Cases where fixed-message lengths cannot be computed statically**: with
   `packetAlwaysContainLength=true`, all messages become variable (§4.3);
   the schema needs to carry this switch, and two rules affect fixed-length
   inference — `std::string` params force variable
   (`message_handler.cpp:201-215`) and ENTITY messages +4 (:218).
3. **STRING dual encoding**: a protocol parameter's `std::string` = NUL-
   terminated without a prefix; an EntityDef UNICODE = u32-prefixed (§3.1).
   If C-15 uses a single String layout it breaks in both the protocol-
   parameter and entity-property contexts; the reader's "stop early at
   non-ASCII" behavior (`memorystream.h:326-330`) must also be replicated
   for byte-for-byte comparison with the engine.
4. **Variable-length semantics**: the u16 length = payload, excluding the
   id+len headers (§4.2) — opposite to some BigWorld documentation's
   "includes headers" wording; C-15's backfill/validation logic must
   explicitly follow the engine (`bundle.cpp:346-347`).
5. **Extended length is legal in only some directions**: external servers
   condemn a decoded >65535 outright (`packet_reader.cpp:165-186`); if C-15
   aligns with the wire behavior, an over-long frame in the external context
   should be judged illegal rather than attempting a decode.
6. **Encryption is a channel property, not a message property**: the
   encrypted frame `u16 encLen + u8 padSize + ciphertext` wraps **outside**
   the message stream (§8); C-15's decode entry must strip frames per the
   channel's encryption state first, with padSize participating in plaintext
   restoration.
7. **No compression layer** (§9): C-15 needs, and should not add, a
   decompression hook.

---

## 14. TODO list (not forensically covered / not statically forensics-able)

- **TODO-1**: whether big-endian compilation (`USE_BIG_ENDIAN`) exists in
  real deployments and each field's flip semantics — inferred only from the
  macro definitions (`platform.h:128-136`); no official usage evidence
  found.
- **TODO-2**: the complete wire format of ENTITYCALL as an EntityDef
  property value (the field order of id/type/utype) —
  `EntityCallType::addToStream` (`datatype.cpp:1512+`) not pinned line by
  line; C-15's existing "16B fixed id+cid+type+utype" claim has not been
  compared against this baseline's source.
- **TODO-3**: the field-level frame format of the server → client property
  sync stream (the alias-ID vs utype dual modes, the volatile position bit
  packing `readPackXYZ`, `memorystream.h:443-452`) — in PA-002's schema
  engine scope; not expanded in Phase 0.
- **TODO-4**: whether historical BigWorld versions had a compression option
  (confirmed absent in this baseline v2.5.10).
- **TODO-5**: line-by-line consistency comparison of UE4's
  `MessageReader.cpp` against the JS/Unity ends.
- **TODO-6**: real server packet capture samples (needs a runnable KBEngine
  deployment + tcpdump/Wireshark) to replace §12's synthetic samples for
  golden verification (consistent with the C-15 wire-probe precedent:
  synthetic derived samples are the current authority; replaced once real
  samples land).
- **TODO-7**: the complete transcription table of all 80 fixed IDs in
  `messages_fixed_defaults.xml` (PA-002 parses the XML and generates it
  automatically; only the key 6 are excerpted here).
- **TODO-8**: the fine differences between message frames inside WebSocket
  channels and raw TCP (whether KBEngine adds its own headers beyond RFC6455
  frame boundaries) — `websocket_packet_filter.*` not pinned line by line.

---

*Output: PA-001 (todo.md). Forensics date 2026-11-06; engine baseline
bf1a9cd6 (v2.5.10).*
