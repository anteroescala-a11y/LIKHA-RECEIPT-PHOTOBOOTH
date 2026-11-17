package com.receiptbooth.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends raw ESC/POS bytes to a thermal printer over USB, classic Bluetooth (SPP) or TCP port 9100.
 * Exposed to the page as window.AndroidPrinter. Slow calls answer through RPB._native(id, ok, message).
 */
public class PrinterBridge {
    private static final String ACTION_USB = "com.receiptbooth.app.USB_PERMISSION";
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int REQ_BLUETOOTH = 2;
    private static final int REQ_STORAGE = 4;

    private final Activity activity;
    private final WebView web;
    private final UsbManager usb;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile UsbDeviceConnection usbConn;
    private volatile UsbInterface usbIface;
    private volatile UsbEndpoint usbOut;
    private volatile BluetoothSocket btSocket;
    private volatile Socket tcp;
    private volatile OutputStream out;
    private volatile InputStream in;
    private volatile UsbEndpoint usbIn;
    private volatile String name = "";
    private volatile String pendingUsbCb;

    private final BroadcastReceiver usbReceiver;

    private BroadcastReceiver makeUsbReceiver() {
        return new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!ACTION_USB.equals(intent.getAction())) return;
            final String cb = pendingUsbCb;
            pendingUsbCb = null;
            if (cb == null) return;
            io.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        UsbDevice d = findPrinter();
                        if (d != null && usb.hasPermission(d)) openUsb(d, cb);
                        else reply(cb, false, "USB access was denied. Replug the printer and tap OK when Android asks.");
                    } catch (Exception e) {
                        closeAll();
                        reply(cb, false, messageOf(e));
                    }
                }
            });
        }
        };
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public PrinterBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.usb = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
        this.usbReceiver = makeUsbReceiver();
        IntentFilter filter = new IntentFilter(ACTION_USB);
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(usbReceiver, filter);
        }
    }

    public void destroy() {
        try {
            activity.unregisterReceiver(usbReceiver);
        } catch (Exception ignored) {
        }
        closeAll();
        io.shutdown();
    }

    /* ---------- called from JavaScript ---------- */

    @JavascriptInterface
    public boolean isConnected() {
        return usbConn != null || out != null;
    }

    @JavascriptInterface
    public String printerName() {
        return name;
    }

    /** JSON array of paired devices, or the string PERMISSION / OFF / NONE. */
    @JavascriptInterface
    @SuppressLint("MissingPermission")
    public String listBluetooth() {
        if (!hasBluetoothPermission()) {
            askBluetoothPermission();
            return "PERMISSION";
        }
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) return "NONE";
        if (!adapter.isEnabled()) return "OFF";
        JSONArray arr = new JSONArray();
        try {
            for (BluetoothDevice d : adapter.getBondedDevices()) {
                JSONObject o = new JSONObject();
                o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                o.put("address", d.getAddress());
                arr.put(o);
            }
        } catch (Exception ignored) {
        }
        return arr.toString();
    }

    @JavascriptInterface
    public void connect(final String type, final String target, final String cb) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    closeAll();
                    if ("usb".equals(type)) connectUsb(cb);
                    else if ("btclassic".equals(type)) connectBluetooth(target, cb);
                    else if ("network".equals(type)) connectNetwork(target, cb);
                    else reply(cb, false, "Unknown connection type.");
                } catch (Exception e) {
                    closeAll();
                    reply(cb, false, messageOf(e));
                }
            }
        });
    }

    @JavascriptInterface
    public void print(final String base64, final String cb) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    UsbDeviceConnection conn = usbConn;
                    OutputStream stream = out;
                    if (conn != null) {
                        int off = 0;
                        while (off < data.length) {
                            int n = Math.min(4096, data.length - off);
                            int sent = conn.bulkTransfer(usbOut, data, off, n, 8000);
                            if (sent <= 0) {
                                throw new IOException("The USB connection dropped mid-print. Check the cable, then print again.");
                            }
                            off += sent;
                        }
                    } else if (stream != null) {
                        int off = 0;
                        while (off < data.length) {
                            int n = Math.min(1024, data.length - off);
                            stream.write(data, off, n);
                            stream.flush();
                            off += n;
                            if (btSocket != null) Thread.sleep(15);
                        }
                    } else {
                        throw new IOException("Printer is not connected.");
                    }
                    reply(cb, true, "ok");
                } catch (Exception e) {
                    closeAll();
                    reply(cb, false, messageOf(e));
                }
            }
        });
    }

    /**
     * Sends a short command and returns whatever the printer answers within timeoutMs, as base64
     * ("" when it stays silent). Used for the paper sensor check; never drops the connection.
     */
    @JavascriptInterface
    public void query(final String base64, final int timeoutMs, final String cb) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                String answer = "";
                try {
                    byte[] cmd = Base64.decode(base64, Base64.DEFAULT);
                    byte[] buf = new byte[16];
                    int n = 0;
                    UsbDeviceConnection conn = usbConn;
                    OutputStream os = out;
                    InputStream is = in;
                    if (conn != null) {
                        if (usbIn != null) {
                            conn.bulkTransfer(usbOut, cmd, cmd.length, 2000);
                            n = conn.bulkTransfer(usbIn, buf, buf.length, timeoutMs);
                        }
                    } else if (os != null && is != null) {
                        while (is.available() > 0) is.read();
                        os.write(cmd);
                        os.flush();
                        long end = System.currentTimeMillis() + timeoutMs;
                        while (System.currentTimeMillis() < end && is.available() == 0) Thread.sleep(20);
                        if (is.available() > 0) n = is.read(buf, 0, Math.min(buf.length, is.available()));
                    }
                    if (n > 0) answer = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP);
                } catch (Exception ignored) {
                }
                reply(cb, true, answer);
            }
        });
    }

    /** Saves a JPEG (base64) into the tablet's photo album under Pictures/Receipt Photobooth. */
    @JavascriptInterface
    public void saveImage(final String base64, final String fileName, final String cb) {
        if (Build.VERSION.SDK_INT < 29
                && activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    activity.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                }
            });
            reply(cb, false, "Allow storage access when Android asks, then save again.");
            return;
        }
        io.execute(new Runnable() {
            @Override
            public void run() {
                Uri uri = null;
                ContentResolver resolver = activity.getContentResolver();
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    if (Build.VERSION.SDK_INT >= 29) {
                        values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Receipt Photobooth");
                    }
                    uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IOException("The photo album is not available.");
                    OutputStream os = resolver.openOutputStream(uri);
                    if (os == null) throw new IOException("The photo album is not available.");
                    try {
                        os.write(data);
                    } finally {
                        os.close();
                    }
                    reply(cb, true, "ok");
                } catch (Exception e) {
                    if (uri != null) {
                        try {
                            resolver.delete(uri, null, null);
                        } catch (Exception ignored) {
                        }
                    }
                    reply(cb, false, "The copy could not be saved: " + messageOf(e));
                }
            }
        });
    }

    @JavascriptInterface
    public void disconnect() {
        io.execute(new Runnable() {
            @Override
            public void run() {
                closeAll();
            }
        });
    }

    /* ---------- USB ---------- */

    private static UsbEndpoint bulkOut(UsbInterface f) {
        for (int i = 0; i < f.getEndpointCount(); i++) {
            UsbEndpoint e = f.getEndpoint(i);
            if (e.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && e.getDirection() == UsbConstants.USB_DIR_OUT) {
                return e;
            }
        }
        return null;
    }

    /** Printer-class devices first; vendor-specific devices with a bulk OUT endpoint as a fallback. */
    private UsbDevice findPrinter() {
        UsbDevice fallback = null;
        for (UsbDevice d : usb.getDeviceList().values()) {
            for (int i = 0; i < d.getInterfaceCount(); i++) {
                UsbInterface f = d.getInterface(i);
                if (bulkOut(f) == null) continue;
                if (f.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return d;
                if (f.getInterfaceClass() == UsbConstants.USB_CLASS_VENDOR_SPEC && fallback == null) fallback = d;
            }
        }
        return fallback;
    }

    private void connectUsb(String cb) {
        UsbDevice d = findPrinter();
        if (d == null) {
            reply(cb, false, "No USB printer detected. Check the cable (an OTG adapter may be needed) and that the printer is on.");
            return;
        }
        if (usb.hasPermission(d)) {
            openUsb(d, cb);
            return;
        }
        pendingUsbCb = cb;
        Intent intent = new Intent(ACTION_USB).setPackage(activity.getPackageName());
        PendingIntent pi = PendingIntent.getBroadcast(activity, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        usb.requestPermission(d, pi);
    }

    private void openUsb(UsbDevice d, String cb) {
        UsbInterface pick = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface f = d.getInterface(i);
            if (bulkOut(f) == null) continue;
            if (pick == null || f.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) pick = f;
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) break;
        }
        if (pick == null) {
            reply(cb, false, "This USB device has no printable output.");
            return;
        }
        UsbDeviceConnection conn = usb.openDevice(d);
        if (conn == null) {
            reply(cb, false, "Could not open the USB printer. Unplug and replug it, then try again.");
            return;
        }
        if (!conn.claimInterface(pick, true)) {
            conn.close();
            reply(cb, false, "The USB printer is busy. Unplug and replug it, then try again.");
            return;
        }
        usbIface = pick;
        usbOut = bulkOut(pick);
        usbIn = null;
        for (int i = 0; i < pick.getEndpointCount(); i++) {
            UsbEndpoint e = pick.getEndpoint(i);
            if (e.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && e.getDirection() == UsbConstants.USB_DIR_IN) {
                usbIn = e;
            }
        }
        usbConn = conn;
        String product = d.getProductName();
        name = product == null || product.isEmpty() ? "USB printer" : product;
        reply(cb, true, name);
    }

    /* ---------- Bluetooth (classic SPP) ---------- */

    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < 31
                || activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void askBluetoothPermission() {
        if (Build.VERSION.SDK_INT < 31) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_BLUETOOTH);
            }
        });
    }

    @SuppressLint("MissingPermission")
    private void connectBluetooth(String address, String cb) throws IOException {
        if (!hasBluetoothPermission()) {
            askBluetoothPermission();
            reply(cb, false, "Allow Bluetooth access when Android asks, then try again.");
            return;
        }
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            reply(cb, false, "This tablet has no Bluetooth.");
            return;
        }
        if (!adapter.isEnabled()) {
            reply(cb, false, "Bluetooth is off. Turn it on in Android settings first.");
            return;
        }
        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(address);
        } catch (IllegalArgumentException e) {
            reply(cb, false, "Choose a paired Bluetooth printer first.");
            return;
        }
        // Cheap thermal printers differ in which kind of serial link they accept, so try all three:
        // secure, insecure, then a fixed channel 1.
        BluetoothSocket socket = null;
        for (int attempt = 0; attempt < 3 && socket == null; attempt++) {
            BluetoothSocket s = null;
            try {
                if (attempt == 0) {
                    s = device.createRfcommSocketToServiceRecord(SPP);
                } else if (attempt == 1) {
                    s = device.createInsecureRfcommSocketToServiceRecord(SPP);
                } else {
                    s = (BluetoothSocket) device.getClass()
                            .getMethod("createRfcommSocket", int.class).invoke(device, 1);
                }
                s.connect();
                socket = s;
            } catch (Exception e) {
                if (s != null) {
                    try {
                        s.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        }
        if (socket == null) {
            throw new IOException("Could not reach the Bluetooth printer. Check that it is on, in range, paired in Android settings, and not connected to another phone.");
        }
        btSocket = socket;
        in = socket.getInputStream();
        out = socket.getOutputStream();
        String n = device.getName();
        name = n == null || n.isEmpty() ? "Bluetooth printer" : n;
        reply(cb, true, name);
    }

    /* ---------- Network (raw port 9100) ---------- */

    private void connectNetwork(String target, String cb) throws IOException {
        String host = target == null ? "" : target.trim();
        int port = 9100;
        int colon = host.lastIndexOf(':');
        if (colon > 0) {
            try {
                port = Integer.parseInt(host.substring(colon + 1));
            } catch (NumberFormatException ignored) {
            }
            host = host.substring(0, colon);
        }
        if (host.isEmpty()) {
            reply(cb, false, "Enter the printer IP address first.");
            return;
        }
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(host, port), 4000);
        } catch (IOException e) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
            throw new IOException("No printer answered at " + host + ":" + port + ". It must be on the same WiFi network as the tablet.");
        }
        tcp = s;
        in = s.getInputStream();
        out = s.getOutputStream();
        name = "Network printer " + host;
        reply(cb, true, name);
    }

    /* ---------- shared ---------- */

    private void closeAll() {
        try {
            if (usbConn != null) {
                if (usbIface != null) usbConn.releaseInterface(usbIface);
                usbConn.close();
            }
        } catch (Exception ignored) {
        }
        try {
            if (out != null) out.close();
        } catch (Exception ignored) {
        }
        try {
            if (btSocket != null) btSocket.close();
        } catch (Exception ignored) {
        }
        try {
            if (tcp != null) tcp.close();
        } catch (Exception ignored) {
        }
        usbConn = null;
        usbIface = null;
        usbOut = null;
        btSocket = null;
        tcp = null;
        out = null;
        in = null;
        usbIn = null;
        name = "";
    }

    private static String messageOf(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? "Printing failed (" + e.getClass().getSimpleName() + ")." : m;
    }

    private void reply(String cb, boolean ok, String message) {
        final String js = "window.RPB&&RPB._native(" + JSONObject.quote(cb) + "," + ok + ","
                + JSONObject.quote(message == null ? "" : message) + ")";
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }
}
