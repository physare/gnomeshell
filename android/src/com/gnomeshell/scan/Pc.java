package com.gnomeshell.scan;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.InterfaceAddress;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Enumeration;

/**
 * Talking to GnomeShell on the PC, over the home Wi-Fi. GnomeShell answers a
 * broadcast on UDP 8771 with its port, and takes photos over plain HTTP on 8770
 * when they carry the 6-digit code shown on its Phone scans panel.
 */
final class Pc {
    static final int FIND_PORT = 8771;
    static final int DEFAULT_PORT = 8770;

    final Context ctx;
    final SharedPreferences prefs;

    Pc(Context c) {
        ctx = c.getApplicationContext();
        prefs = ctx.getSharedPreferences("pc", Context.MODE_PRIVATE);
    }

    String host() { return prefs.getString("host", ""); }
    int port() { return prefs.getInt("port", DEFAULT_PORT); }
    String code() { return prefs.getString("code", ""); }
    String name() { return prefs.getString("name", ""); }

    void setHost(String host, int port, String name) {
        prefs.edit().putString("host", host).putInt("port", port).putString("name", name == null ? "" : name).apply();
    }

    void setCode(String code) { prefs.edit().putString("code", code.trim()).apply(); }

    /** Shout "where's GnomeShell?" on the Wi-Fi and wait for an answer. Blocking. */
    boolean find() {
        WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = null;
        DatagramSocket s = null;
        try {
            if (wm != null) {
                lock = wm.createMulticastLock("gnomeshell-find");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
            s = new DatagramSocket();
            s.setBroadcast(true);
            s.setSoTimeout(700);
            byte[] ask = "GNOMESHELL_SCAN_FIND".getBytes("UTF-8");
            for (int attempt = 0; attempt < 3; attempt++) {
                for (InetAddress b : broadcasts()) {
                    try { s.send(new DatagramPacket(ask, ask.length, b, FIND_PORT)); } catch (Exception ignored) { }
                }
                long until = System.currentTimeMillis() + 900;
                while (System.currentTimeMillis() < until) {
                    try {
                        byte[] buf = new byte[512];
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        s.receive(p);
                        JSONObject j = new JSONObject(new String(p.getData(), 0, p.getLength(), "UTF-8"));
                        if ("GnomeShell".equals(j.optString("app"))) {
                            setHost(p.getAddress().getHostAddress(), j.optInt("port", DEFAULT_PORT), j.optString("name"));
                            return true;
                        }
                    } catch (java.net.SocketTimeoutException e) {
                        break;
                    } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (s != null) s.close();
            if (lock != null) try { lock.release(); } catch (Exception ignored) { }
        }
        return false;
    }

    private static java.util.List<InetAddress> broadcasts() {
        java.util.List<InetAddress> out = new java.util.ArrayList<>();
        try {
            Enumeration<NetworkInterface> it = NetworkInterface.getNetworkInterfaces();
            while (it != null && it.hasMoreElements()) {
                NetworkInterface ni = it.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress a : ni.getInterfaceAddresses()) {
                    if (a.getBroadcast() != null) out.add(a.getBroadcast());
                }
            }
        } catch (Exception ignored) { }
        try { out.add(InetAddress.getByName("255.255.255.255")); } catch (Exception ignored) { }
        return out;
    }

    String base() { return "http://" + host() + ":" + port(); }

    /** GET /phone/hello: is GnomeShell there, and does it take our code? */
    JSONObject hello() throws Exception {
        return json("GET", "/phone/hello", null, 2500);
    }

    JSONObject newScan(String name) throws Exception {
        JSONObject b = new JSONObject();
        b.put("name", name);
        b.put("device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        return json("POST", "/phone/scans", b.toString().getBytes("UTF-8"), 10000);
    }

    void putPhoto(String id, File f) throws Exception {
        HttpURLConnection c = open("PUT", "/phone/scans/" + enc(id) + "/photos/" + enc(f.getName()), 60000);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(f.length());
        c.setRequestProperty("Content-Type", "image/jpeg");
        try (OutputStream out = c.getOutputStream(); InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        finish(c);
    }

    JSONObject done(String id, int count, JSONObject capture) throws Exception {
        JSONObject b = new JSONObject();
        b.put("count", count);
        if (capture != null) b.put("capture", capture);
        return json("POST", "/phone/scans/" + enc(id) + "/done", b.toString().getBytes("UTF-8"), 15000);
    }

    JSONObject status(String id) throws Exception {
        return json("GET", "/phone/scans/" + enc(id), null, 5000);
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
    }

    private HttpURLConnection open(String method, String path, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base() + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(Math.min(timeout, 4000));
        c.setReadTimeout(timeout);
        c.setRequestProperty("X-GnomeShell-Code", code());
        return c;
    }

    private JSONObject json(String method, String path, byte[] body, int timeout) throws Exception {
        HttpURLConnection c = open(method, path, timeout);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) { out.write(body); }
        }
        return finish(c);
    }

    private static JSONObject finish(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            in.close();
        }
        c.disconnect();
        JSONObject j;
        try { j = new JSONObject(b.toString("UTF-8")); } catch (Exception e) { j = new JSONObject(); }
        if (code >= 400) throw new Exception(j.optString("error", "GnomeShell said no (" + code + ")"));
        return j;
    }
}
