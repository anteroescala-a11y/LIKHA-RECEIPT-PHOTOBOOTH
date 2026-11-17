/* ESC/POS raster encoder and printer transports (WebUSB, Web Bluetooth, Web Serial). */
(function () {
  const RPB = (window.RPB = window.RPB || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* bitmap: {bits (1 = black), w, h}. o: {chunkRows, feedLines, cut}
     Emits ESC @, centre align, one or more GS v 0 raster blocks, feed, cut. */
  function encodeRaster(bitmap, o) {
    const { bits, w, h } = bitmap;
    const bpr = (w + 7) >> 3;
    const rows = new Uint8Array(bpr * h);
    for (let y = 0; y < h; y++) {
      const src = y * w, dst = y * bpr;
      for (let x = 0; x < w; x++) if (bits[src + x]) rows[dst + (x >> 3)] |= 0x80 >> (x & 7);
    }
    const parts = [[0x1b, 0x40], [0x1b, 0x61, 0x01]];
    const step = o.chunkRows > 0 ? Math.min(o.chunkRows, 2000) : Math.min(h, 2000);
    for (let y0 = 0; y0 < h; y0 += step) {
      const n = Math.min(step, h - y0);
      parts.push([0x1d, 0x76, 0x30, 0x00, bpr & 255, bpr >> 8, n & 255, n >> 8]);
      parts.push(rows.subarray(y0 * bpr, (y0 + n) * bpr));
    }
    const feed = Math.max(0, Math.min(20, o.feedLines | 0));
    if (feed) parts.push([0x1b, 0x64, feed]);
    if (o.cut) parts.push([0x1d, 0x56, 0x42, 0x00]);
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  const BLE_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
  ];

  /* Inside the Android app, window.AndroidPrinter talks to the printer natively. */
  const native = window.AndroidPrinter || null;
  const NATIVE_TYPES = ['usb', 'btclassic', 'network'];
  const pending = {};
  let callSeq = 0;
  RPB._native = (id, ok, msg) => {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.res(msg); else p.rej(new Error(msg));
  };
  const nativeCall = (fn, ...args) => new Promise((res, rej) => {
    const id = 'c' + (++callSeq);
    pending[id] = { res, rej };
    native[fn](...args, id);
  });
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  }

  const printer = {
    type: null,
    name: '',
    _isNative: false,
    _usb: null, _ep: 0,
    _port: null,
    _ble: null, _char: null,

    connected() {
      if (this._isNative) return native.isConnected();
      if (this.type === 'usb') return !!(this._usb && this._usb.opened);
      if (this.type === 'serial') return !!(this._port && this._port.writable);
      if (this.type === 'bluetooth') return !!(this._ble && this._ble.gatt.connected && this._char);
      return false;
    },

    async connect(type, s) {
      await this.disconnect();
      if (native && NATIVE_TYPES.includes(type)) {
        const target = type === 'btclassic' ? (s.btAddress || '') : type === 'network' ? (s.printerIp || '') : '';
        if (type === 'btclassic' && !target) throw new Error('Choose a paired Bluetooth printer in the settings first.');
        if (type === 'network' && !target) throw new Error('Enter the printer IP address in the settings first.');
        this.name = await nativeCall('connect', type, target);
        this.type = type;
        this._isNative = true;
        return this.name;
      }
      if (type === 'usb') {
        if (!navigator.usb) throw new Error('WebUSB is not available here. Use Chrome or Edge.');
        await this._openUsb(await navigator.usb.requestDevice({ filters: [] }));
      } else if (type === 'serial') {
        if (!navigator.serial) throw new Error('Web Serial is not available here. Use Chrome or Edge on a computer.');
        await this._openSerial(await navigator.serial.requestPort(), s);
      } else if (type === 'bluetooth') {
        if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available here. Use Chrome or Edge.');
        const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
        await this._openBle(dev);
      } else {
        throw new Error('Unknown connection type: ' + type);
      }
      this.type = type;
      return this.name;
    },

    /* Reopen a device the user already granted, without a prompt. */
    async restore(type, s) {
      if (native) return false; // the app reconnects on the next print
      try {
        if (type === 'usb' && navigator.usb) {
          const list = await navigator.usb.getDevices();
          if (list.length) { await this._openUsb(list[0]); this.type = 'usb'; return true; }
        } else if (type === 'serial' && navigator.serial) {
          const list = await navigator.serial.getPorts();
          if (list.length) { await this._openSerial(list[0], s); this.type = 'serial'; return true; }
        }
      } catch (e) { /* stays disconnected */ }
      return false;
    },

    async _openUsb(dev) {
      await dev.open();
      if (!dev.configuration) await dev.selectConfiguration(1);
      let pick = null;
      for (const iface of dev.configuration.interfaces) {
        for (const alt of iface.alternates) {
          const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
          if (!ep) continue;
          const epIn = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
          const cand = { iface: iface.interfaceNumber, alt: alt.alternateSetting, ep: ep.endpointNumber, epIn: epIn ? epIn.endpointNumber : 0, cls: alt.interfaceClass };
          if (!pick || (cand.cls === 7 && pick.cls !== 7)) pick = cand;
        }
      }
      if (!pick) { await dev.close(); throw new Error('This USB device has no printable output endpoint.'); }
      try {
        await dev.claimInterface(pick.iface);
      } catch (e) {
        await dev.close().catch(() => {});
        throw new Error('The USB printer is held by a system driver. On Windows, use Serial/Browser print, or swap its driver to WinUSB with Zadig.');
      }
      if (pick.alt) await dev.selectAlternateInterface(pick.iface, pick.alt);
      this._usb = dev;
      this._ep = pick.ep;
      this._epIn = pick.epIn;
      this.name = dev.productName || 'USB printer';
    },

    async _openSerial(port, s) {
      if (!port.writable) await port.open({ baudRate: Number(s && s.baud) || 9600 });
      this._port = port;
      this.name = 'Serial port';
    },

    async _openBle(dev) {
      const gatt = await dev.gatt.connect();
      const services = await gatt.getPrimaryServices();
      for (const svc of services) {
        for (const ch of await svc.getCharacteristics()) {
          if (ch.properties.writeWithoutResponse || ch.properties.write) {
            this._ble = dev;
            this._char = ch;
            this.name = dev.name || 'Bluetooth printer';
            return;
          }
        }
      }
      gatt.disconnect();
      throw new Error('No writable print channel found on this Bluetooth device. Classic (non-BLE) printers need the Serial option after pairing in the system settings.');
    },

    async write(bytes) {
      if (!this.connected()) throw new Error('Printer is not connected.');
      if (this._isNative) {
        await nativeCall('print', toBase64(bytes));
        return;
      }
      if (this.type === 'usb') {
        for (let i = 0; i < bytes.length; i += 16384) {
          const r = await this._usb.transferOut(this._ep, bytes.subarray(i, i + 16384));
          if (r.status !== 'ok') throw new Error('USB transfer failed: ' + r.status);
        }
      } else if (this.type === 'serial') {
        const wr = this._port.writable.getWriter();
        try {
          for (let i = 0; i < bytes.length; i += 4096) await wr.write(bytes.subarray(i, i + 4096));
        } finally { wr.releaseLock(); }
      } else {
        const noResp = this._char.properties.writeWithoutResponse;
        for (let i = 0; i < bytes.length; i += 120) {
          const chunk = bytes.subarray(i, i + 120);
          if (noResp) { await this._char.writeValueWithoutResponse(chunk); await sleep(12); }
          else await this._char.writeValueWithResponse(chunk);
        }
      }
    },

    /* Asks the printer for its paper sensor (DLE EOT 4). Returns 'ok', 'out' or 'unknown'.
       Many low-cost printers never answer, so 'unknown' must not block printing. */
    async status() {
      if (!this.connected()) return 'unknown';
      const cmd = new Uint8Array([0x10, 0x04, 0x04]);
      const wait = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
      let byte = null;
      try {
        if (this._isNative) {
          const reply = await nativeCall('query', toBase64(cmd), 800);
          if (reply) byte = atob(reply).charCodeAt(0);
        } else if (this.type === 'usb' && this._epIn) {
          await this._usb.transferOut(this._ep, cmd);
          const r = await Promise.race([this._usb.transferIn(this._epIn, 8), wait(800)]);
          if (r && r.data && r.data.byteLength) byte = r.data.getUint8(0);
        } else if (this.type === 'serial' && this._port.readable) {
          const wr = this._port.writable.getWriter();
          try { await wr.write(cmd); } finally { wr.releaseLock(); }
          const rd = this._port.readable.getReader();
          try {
            const r = await Promise.race([rd.read(), wait(800)]);
            if (r && r.value && r.value.length) byte = r.value[0];
          } finally { await rd.cancel().catch(() => {}); rd.releaseLock(); }
        }
      } catch (e) { return 'unknown'; }
      // A valid reply has bit 1 and bit 4 set and bit 0 and bit 7 clear.
      if (byte == null || (byte & 0x93) !== 0x12) return 'unknown';
      return byte & 0x60 ? 'out' : 'ok';
    },

    async disconnect() {
      if (this._isNative) { try { native.disconnect(); } catch (e) { /* ignore */ } }
      this._isNative = false;
      try {
        if (this._usb && this._usb.opened) await this._usb.close();
        if (this._port && this._port.writable) await this._port.close();
        if (this._ble && this._ble.gatt.connected) this._ble.gatt.disconnect();
      } catch (e) { /* ignore */ }
      this._usb = this._port = this._ble = this._char = null;
      this.type = null;
      this.name = '';
    },
  };

  RPB.native = native;
  RPB.nativeCall = native ? nativeCall : null;
  RPB.escpos = { encodeRaster };
  RPB.printer = printer;
})();
