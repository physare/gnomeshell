package com.gnomeshell.scan;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;

/** Home: the PC link, "New scan", and the scans on this phone. */
public class MainActivity extends Activity {
    private Pc pc;
    private TextView pcLine, pcSub;
    private Button pcFix;
    private LinearLayout list;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean checking;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        pc = new Pc(this);
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = Ui.dp(this, 20);
        col.setPadding(p, Ui.dp(this, 28), p, p);
        sv.addView(col);

        LinearLayout brand = Ui.row(this);
        ImageView logo = new ImageView(this);
        logo.setImageBitmap(BitmapFactory.decodeResource(getResources(), R.drawable.logo));
        brand.addView(logo, new LinearLayout.LayoutParams(Ui.dp(this, 44), Ui.dp(this, 44)));
        brand.addView(Ui.gap(this, 12));
        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.addView(Ui.text(this, "GnomeShell", 22, Ui.TEXT, true));
        names.addView(Ui.text(this, "Scan", 14, Ui.GOLD, true));
        brand.addView(names);
        col.addView(brand);

        Button scan = Ui.button(this, "New scan", true);
        scan.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askName(); }
        });
        col.addView(scan, Ui.wide(this, 24));

        TextView how = Ui.text(this, "Stand the object on the printed scan sheet, then walk round it taking photos. "
                + "The rings on screen fill in as you go. When you're done, the photos go to GnomeShell on your PC, "
                + "which builds the 3D model.", 14, Ui.MUTED, false);
        how.setLineSpacing(0, 1.2f);
        col.addView(how, Ui.wide(this, 12));

        col.addView(Ui.heading(this, "Your PC"));
        LinearLayout card = Ui.card(this);
        pcLine = Ui.text(this, "Looking for GnomeShell…", 16, Ui.TEXT, true);
        pcSub = Ui.text(this, "", 13, Ui.MUTED, false);
        pcSub.setLineSpacing(0, 1.15f);
        card.addView(pcLine);
        card.addView(pcSub, Ui.wide(this, 4));
        LinearLayout btns = Ui.row(this);
        pcFix = Ui.button(this, "Enter code", false);
        pcFix.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askCode(); }
        });
        Button addr = Ui.button(this, "Type address", false);
        addr.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { askAddress(); }
        });
        Button again = Ui.button(this, "Look again", false);
        again.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { checkPc(true); }
        });
        btns.addView(pcFix);
        btns.addView(Ui.gap(this, 8));
        btns.addView(addr);
        btns.addView(Ui.gap(this, 8));
        btns.addView(again);
        card.addView(btns, Ui.wide(this, 12));
        col.addView(card, Ui.wide(this, 0));

        col.addView(Ui.heading(this, "Scans on this phone"));
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        col.addView(list);
        setContentView(sv);
    }

    @Override
    protected void onResume() {
        super.onResume();
        showScans();
        checkPc(false);
    }

    private void checkPc(final boolean search) {
        if (checking) return;
        checking = true;
        pcLine.setText("Looking for GnomeShell…");
        pcSub.setText("Open GnomeShell on your PC. The phone and PC need to be on the same Wi-Fi.");
        new Thread(new Runnable() {
            public void run() {
                String line, sub;
                boolean needCode = false;
                JSONObject h = null;
                if (!pc.host().isEmpty() && !search) {
                    try { h = pc.hello(); } catch (Exception ignored) { }
                }
                if (h == null && pc.find()) {
                    try { h = pc.hello(); } catch (Exception ignored) { }
                }
                if (h == null) {
                    line = "GnomeShell not found";
                    sub = "Open GnomeShell on your PC (it listens for the phone while it's open), and check both are on "
                            + "the same Wi-Fi. If Windows asked about Blender and networks, choose Allow. "
                            + "You can still take scans now and send them later.";
                } else if (!h.optBoolean("paired")) {
                    line = "Found " + h.optString("name", "your PC");
                    sub = "Enter the 6-digit code from GnomeShell's Phone scans panel (on the Load scan screen).";
                    needCode = true;
                } else {
                    line = "Connected to " + h.optString("name", "your PC");
                    sub = pc.host() + " · GnomeShell " + h.optString("version");
                }
                final String l = line, s = sub;
                final boolean nc = needCode;
                ui.post(new Runnable() {
                    public void run() {
                        checking = false;
                        pcLine.setText(l);
                        pcLine.setTextColor(l.startsWith("Connected") ? Ui.OK : Ui.TEXT);
                        pcSub.setText(s);
                        pcFix.setText(nc ? "Enter code" : "Change code");
                        if (nc && pc.code().isEmpty()) askCode();
                    }
                });
            }
        }).start();
    }

    private void askCode() {
        final EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_NUMBER);
        e.setText(pc.code());
        e.setTextSize(24);
        e.setGravity(Gravity.CENTER);
        new AlertDialog.Builder(this)
                .setTitle("Code from GnomeShell")
                .setMessage("In GnomeShell on your PC, the Phone scans panel shows a 6-digit code.")
                .setView(e)
                .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        pc.setCode(e.getText().toString());
                        checkPc(false);
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void askAddress() {
        final EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        e.setHint("192.168.1.20");
        e.setText(pc.host());
        new AlertDialog.Builder(this)
                .setTitle("PC address")
                .setMessage("Only needed if the phone can't find GnomeShell by itself. The Phone scans panel in "
                        + "GnomeShell shows the address.")
                .setView(e)
                .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        String s = e.getText().toString().trim().replace("http://", "");
                        int port = Pc.DEFAULT_PORT;
                        int k = s.lastIndexOf(':');
                        if (k > 0) {
                            try { port = Integer.parseInt(s.substring(k + 1)); } catch (Exception ignored) { }
                            s = s.substring(0, k);
                        }
                        pc.setHost(s, port, "");
                        checkPc(false);
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void askName() {
        final EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        e.setHint("Garden gnome");
        new AlertDialog.Builder(this)
                .setTitle("What are you scanning?")
                .setView(e)
                .setPositiveButton("Start", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        String n = e.getText().toString().trim();
                        File scan = Store.newScan(MainActivity.this, n.isEmpty() ? "Phone scan" : n);
                        Intent i = new Intent(MainActivity.this, CaptureActivity.class);
                        i.putExtra("scan", scan.getAbsolutePath());
                        startActivity(i);
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void showScans() {
        list.removeAllViews();
        java.util.List<File> scans = Store.scans(this);
        if (scans.isEmpty()) {
            list.addView(Ui.text(this, "None yet.", 14, Ui.MUTED, false));
            return;
        }
        for (final File s : scans) {
            JSONObject j = Store.load(s);
            int n = Store.photos(s).length;
            if (n == 0 && !"taking".equals(j.optString("state"))) continue;
            LinearLayout c = Ui.card(this);
            c.addView(Ui.text(this, j.optString("name", "Scan"), 16, Ui.TEXT, true));
            String st = j.optString("state");
            String what = st.equals("sent") ? "Sent to " + j.optString("pc", "your PC")
                    : st.equals("ready") ? "Ready in GnomeShell"
                    : st.equals("failed") ? "Didn't build: " + j.optString("message")
                    : st.equals("building") ? "Building on your PC" : "Not sent yet";
            c.addView(Ui.text(this, n + " photos · " + j.optString("created") + " · " + what, 13,
                    st.equals("ready") ? Ui.OK : st.equals("failed") ? Ui.BAD : Ui.MUTED, false), Ui.wide(this, 4));
            c.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    Intent i = new Intent(MainActivity.this, ScanActivity.class);
                    i.putExtra("scan", s.getAbsolutePath());
                    startActivity(i);
                }
            });
            list.addView(c, Ui.wide(this, 8));
        }
    }
}
