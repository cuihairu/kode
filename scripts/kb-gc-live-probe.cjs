// KB-GC-001 真机联验探针:发现 machined(跨机广播)→ logger 长连 → 702 注册
// → 65501 真实日志推流采集 → 703 注销。全部走生产编解码(out/kbengineProtocol.js)。
const p = require('/home/cui/workspaces/kode/out/kbengineProtocol.js');
const net = require('net');

const host = process.env.KODE_LIV_DISCOVERY_HOST || '255.255.255.255';
const collectMs = Number(process.env.KB_GC_COLLECT_MS || 12000);

const main = async () => {
  const comps = await p.discoverLocalComponents({ host, timeoutMs: 3000 });
  console.log(`[probe] discovery(${host}) -> ${comps.length} components`);
  for (const c of comps) {
    console.log(`[probe]   ${c.fullName} type=${c.componentType} id=${c.componentID} pid=${c.pid} ${c.intaddr}:${c.intport} cpu=${c.cpu.toFixed(2)} mem=${c.mem.toFixed(1)} usedmem=${c.usedmem} state=${c.state} uid=${c.uid}`);
  }
  const logger = comps.find(c => c.componentType === 10);
  if (!logger) {
    console.log('[probe] NO LOGGER COMPONENT — tail untestable this round');
    return;
  }
  console.log(`[probe] logger=${logger.fullName} ${logger.intaddr}:${logger.intport} uid=${logger.uid}`);

  const socket = net.connect(logger.intport, logger.intaddr);
  let received = 0;
  const raw0 = [];
  let registrationFrame = null;
  socket.once('connect', () => {
    const body = p.buildLogWatcherRequestBody({
      uid: logger.uid,
      logtypes: p.KBELOG_TYPES_MASK,
      globalOrder: 0,
      groupOrder: 0,
      date: '',
      keyStr: '',
      componentTypes: p.SERVER_COMPONENT_TYPES,
      isfind: false,
      first: true
    });
    registrationFrame = p.buildFrame(p.LOGGER_REGISTER_LOG_WATCHER_MSG_ID, body);
    console.log(`[probe] sending 702 register frame, len=${registrationFrame.length} (uid=${logger.uid}, types=${p.SERVER_COMPONENT_TYPES.join(',')})`);
    socket.write(registrationFrame);
  });

  let buffer = Buffer.alloc(0);
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const id = buffer.readUInt16LE(0);
      const len = buffer.readUInt16LE(2);
      if (buffer.length < 4 + len) break;
      const body = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      if (id !== p.CONSOLE_LOG_MSG_ID) {
        console.log(`[probe] non-log frame id=${id}`);
        continue;
      }
      const texts = p.parseConsoleLogBody(body);
      for (const text of texts || []) {
        received += 1;
        if (raw0.length < 6) raw0.push(text);
        const parsed = p.parseLogStream(text);
        if (received <= 10) {
          console.log(`[probe] 65501 #${received}: ${parsed ? `${parsed.timestamp} [${parsed.level}] ${parsed.component}${String(parsed.groupOrder).padStart(2, '0')}: ${parsed.message.split('\n')[0].slice(0, 90)}` : text.slice(0, 110)}`);
        }
      }
    }
  });
  socket.on('error', err => console.log(`[probe] socket error: ${err.message}`));

  // 连接保活心跳(701)一次,验证帧被接受(无错误回包)
  setTimeout(() => {
    socket.write(p.buildFrame(p.LOGGER_APP_ACTIVE_TICK_MSG_ID, p.buildAppActiveTickBody(9, 0n)));
    console.log('[probe] sent 701 app-active tick');
  }, 5000);

  setTimeout(() => {
    socket.write(p.buildFrame(p.LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID, Buffer.alloc(0)));
    console.log('[probe] sent 703 deregister');
    setTimeout(() => {
      socket.destroy();
      console.log(`[probe] TOTAL 65501 receipts: ${received}`);
      console.log('[probe] RAW SAMPLES:');
      for (const r of raw0) console.log(`[probe]   RAW| ${JSON.stringify(r.slice(0, 160))}`);
      process.exit(0);
    }, 500);
  }, collectMs);
};

main().catch(err => {
  console.error('[probe] FAILED:', err);
  process.exit(1);
});
