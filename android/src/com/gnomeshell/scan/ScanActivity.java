package com.gnomeshell.scan;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;

/** One scan on the phone: send it to GnomeShell and follow the build. */
public class ScanActivity extends Activity {
    private File scan;
    private Pc pc;
    private TextView title, sub, status;
    private ProgressBar bar;
    private Button send;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean sending, visible;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        scan = new File(getIntent().getStringExtra("scan"));
        pc = new Pc(this);

        ScrollView sv = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 20);
        col.setPadding(p, Ui.dp(this, 28), p, p);
        sv.addView(col);

        title = Ui.text(this, "", 22, Ui.TEXT, true);
        col.addView(title);
        sub = Ui.text(this, "", 14, Ui.MUTED, false);
        col.addView(sub, Ui.wide(this, 4));

        ImageView first = new ImageView(this);
        first.setAdjustViewBounds(true);
        File[] ph = Store.photos(scan);
        if (ph.length > 0) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 8;
            Bitmap bm = BitmapFactory.decodeFile(ph[ph.length / 2].getAbsolutePath(), o);
            if (bm != null) {
                Matrix m = new Matrix();
                m.postRotate(90);  // photos are saved the way the sensor sits; shown upright here
                first.setImageBitmap(Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true));
            }
        }
        first.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12, this));
        col.addView(first, Ui.wide(this, 16));

        LinearLayout card = Ui.card(this);
        status = Ui.text(this, "", 16, Ui.TEXT, true);
        status.setLineSpacing(0, 1.15f);
        card.addView(status);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.GOLD));
        card.addView(bar, Ui.wide(this, 10));
        col.addView(card, Ui.wide(this, 16));

        send = Ui.button(this, "Send to GnomeShell", true);
        send.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { sendAll(); }
        });
        col.addView(send, Ui.wide(this, 16));

        Button more = Ui.button(this, "Take more photos", false);
        more.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Intent i = new Intent(ScanActivity.this, CaptureActivity.class);
                i.putExtra("scan", scan.getAbsolutePath());
                startActivity(i);
                finish();
            }
        });
        col.addView(more, Ui.wide(this, 10));
        Button del = Ui.button(this, "Delete from phone", false);
        del.setTextColor(Ui.BAD);
        del.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                new AlertDialog.Builder(ScanActivity.this)
                        .setTitle("Delete this scan from the phone?")
                        .setMessage("Anything already sent stays on your PC.")
                        .setPositiveButton("Delete", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) { Store.delete(scan); finish(); }
                        })
                        .setNegativeButton("Cancel", null)
                        .show();
            }
        });
        col.addView(del, Ui.wide(this, 10));
        setContentView(sv);
        refresh();
        if (getIntent().getBooleanExtra("send", false)) sendAll();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        follow();
    }

    @Override
    protected void onPause() {
        visible = false;
        super.onPause();
    }

    private void refresh() {
        JSONObject j = Store.load(scan);
        int n = Store.photos(scan).length;
        title.setText(j.optString("name", "Scan"));
        JSONObject cap = j.optJSONObject("capture");
        sub.setText(n + " photos · " + j.optString("created") + (cap != null ? " · rings " + cap.optString("coverage") + " filled" : ""));
        String st = j.optString("state");
        if (!sending) {
            if (st.equals("ready")) {
                status.setText(j.optString("message", "Ready") + "\nIn GnomeShell, open it from Phone scans on the Load scan screen.");
                status.setTextColor(Ui.OK);
                bar.setProgress(100);
                send.setText("Send again");
            } else if (st.equals("failed")) {
                status.setText("It didn't build: " + j.optString("message"));
                status.setTextColor(Ui.BAD);
                send.setText("Send again");
            } else if (st.equals("sent") || st.equals("building")) {
                status.setText(j.optString("message", "Sent. Building on your PC…"));
                status.setTextColor(Ui.TEXT);
                bar.setProgress(j.optInt("percent", 0));
            } else {
                status.setText("Not sent yet. Open GnomeShell on your PC, then press Send.");
                status.setTextColor(Ui.TEXT);
                bar.setProgress(0);
            }
        }
    }

    private void say(final String s, final int color, final int pct) {
        ui.post(new Runnable() {
            public void run() {
                status.setText(s);
                status.setTextColor(color);
                if (pct >= 0) bar.setProgress(pct);
            }
        });
    }

    private void sendAll() {
        if (sending) return;
        sending = true;
        send.setEnabled(false);
        new Thread(new Runnable() {
            public void run() {
                PowerManager.WakeLock wl = ((PowerManager) getSystemService(POWER_SERVICE))
                        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gnomeshell:send");
                wl.acquire(30 * 60 * 1000L);
                try {
                    say("Finding GnomeShell on your PC…", Ui.TEXT, 0);
                    JSONObject h = null;
                    try { h = pc.hello(); } catch (Exception ignored) { }
                    if (h == null && pc.find()) {
                        try { h = pc.hello(); } catch (Exception ignored) { }
                    }
                    if (h == null) throw new Exception("GnomeShell isn't answering. Open it on your PC (same Wi-Fi), then press Send again.");
                    if (!h.optBoolean("paired")) throw new Exception("GnomeShell needs its code. Go back and press Enter code on the home screen.");
                    JSONObject j = Store.load(scan);
                    String id = pc.newScan(j.optString("name", "Phone scan")).getString("id");
                    File[] ph = Store.photos(scan);
                    for (int i = 0; i < ph.length; i++) {
                        say("Sending photo " + (i + 1) + " of " + ph.length + "…", Ui.TEXT, Math.round(100f * i / ph.length));
                        Exception last = null;
                        for (int attempt = 0; attempt < 3; attempt++) {
                            try { pc.putPhoto(id, ph[i]); last = null; break; } catch (Exception e) { last = e; Thread.sleep(1500); }
                        }
                        if (last != null) throw last;
                    }
                    JSONObject r = pc.done(id, ph.length, j.optJSONObject("capture"));
                    Store.put(scan, "pc_id", id);
                    Store.put(scan, "pc", h.optString("name", "your PC"));
                    Store.put(scan, "state", "sent");
                    Store.put(scan, "message", r.optString("message", "Sent"));
                    say("All " + ph.length + " photos sent. GnomeShell is building the model; this page follows along.", Ui.OK, 0);
                } catch (Exception e) {
                    say("Not sent: " + e.getMessage(), Ui.BAD, -1);
                } finally {
                    wl.release();
                    sending = false;
                    ui.post(new Runnable() {
                        public void run() {
                            send.setEnabled(true);
                            refresh();
                            follow();
                        }
                    });
                }
            }
        }).start();
    }

    /** While this page is open, check on the build every few seconds. */
    private void follow() {
        final String id = Store.load(scan).optString("pc_id");
        String st = Store.load(scan).optString("state");
        if (id.isEmpty() || !(st.equals("sent") || st.equals("building")) || sending) return;
        new Thread(new Runnable() {
            public void run() {
                while (visible && !sending) {
                    try {
                        JSONObject s = pc.status(id);
                        String state = s.optString("state");
                        String msg = s.optString("message");
                        if (state.equals("done")) {
                            Store.put(scan, "state", "ready");
                            Store.put(scan, "message", msg);
                        } else if (state.equals("failed") || state.equals("stopped")) {
                            Store.put(scan, "state", "failed");
                            Store.put(scan, "message", msg.isEmpty() ? s.optString("error") : msg);
                        } else {
                            Store.put(scan, "state", "building");
                            Store.put(scan, "message", (state.equals("queued") ? "Waiting its turn on your PC" : msg)
                                    + (s.has("percent") && !s.isNull("percent") ? " (" + s.optInt("percent") + "%)" : ""));
                            Store.put(scan, "percent", s.optInt("percent", 0));
                        }
                        ui.post(new Runnable() { public void run() { refresh(); } });
                        if (state.equals("done") || state.equals("failed") || state.equals("stopped")) return;
                    } catch (Exception e) {
                        // the PC may be busy or asleep; keep trying while the page is open
                    }
                    try { Thread.sleep(4000); } catch (InterruptedException e) { return; }
                }
            }
        }).start();
    }
}
