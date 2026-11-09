package com.gnomeshell.scan;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Scans kept on the phone: one folder of JPEGs each, with a scan.json. */
final class Store {
    private Store() {}

    static File root(Context c) {
        File f = new File(c.getFilesDir(), "scans");
        f.mkdirs();
        return f;
    }

    static File newScan(Context c, String name) {
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        File d = new File(root(c), stamp);
        d.mkdirs();
        JSONObject j = new JSONObject();
        try {
            j.put("name", name);
            j.put("created", new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(new Date()));
            j.put("state", "taking");
        } catch (Exception ignored) { }
        save(d, j);
        return d;
    }

    static List<File> scans(Context c) {
        File[] fs = root(c).listFiles();
        List<File> out = new ArrayList<>();
        if (fs == null) return out;
        Arrays.sort(fs, new Comparator<File>() {
            public int compare(File a, File b) { return b.getName().compareTo(a.getName()); }
        });
        for (File f : fs) if (f.isDirectory() && new File(f, "scan.json").exists()) out.add(f);
        return out;
    }

    static File[] photos(File scan) {
        File[] fs = scan.listFiles();
        List<File> out = new ArrayList<>();
        if (fs != null) for (File f : fs) if (f.getName().endsWith(".jpg")) out.add(f);
        File[] a = out.toArray(new File[0]);
        Arrays.sort(a);
        return a;
    }

    static synchronized JSONObject load(File scan) {
        try (FileInputStream in = new FileInputStream(new File(scan, "scan.json"))) {
            byte[] b = new byte[(int) new File(scan, "scan.json").length()];
            int n = 0;
            while (n < b.length) {
                int r = in.read(b, n, b.length - n);
                if (r < 0) break;
                n += r;
            }
            return new JSONObject(new String(b, 0, n, "UTF-8"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static synchronized void save(File scan, JSONObject j) {
        File tmp = new File(scan, "scan.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(j.toString(1).getBytes("UTF-8"));
        } catch (Exception ignored) { }
        tmp.renameTo(new File(scan, "scan.json"));
    }

    static void put(File scan, String key, Object value) {
        JSONObject j = load(scan);
        try { j.put(key, value); } catch (Exception ignored) { }
        save(scan, j);
    }

    static void delete(File scan) {
        File[] fs = scan.listFiles();
        if (fs != null) for (File f : fs) f.delete();
        scan.delete();
    }
}
