package com.gnomeshell.scan;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** GnomeShell's look (the desktop app's colours), for views built in code. */
final class Ui {
    static final int GROUND = Color.parseColor("#16181a");
    static final int PANEL = Color.parseColor("#1e2124");
    static final int CARD = Color.parseColor("#24282b");
    static final int LINE = Color.parseColor("#2d3236");
    static final int TEXT = Color.parseColor("#e8e6e1");
    static final int MUTED = Color.parseColor("#a3aaaf");
    static final int GOLD = Color.parseColor("#e3a33c");
    static final int GOLD_INK = Color.parseColor("#1a1408");
    static final int TEAL = Color.parseColor("#5fa497");
    static final int OK = Color.parseColor("#7cc2b4");
    static final int BAD = Color.parseColor("#e5674a");

    private Ui() {}

    static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    static GradientDrawable round(int fill, int stroke, float radiusDp, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(c, radiusDp));
        if (stroke != 0) g.setStroke(dp(c, 1), stroke);
        return g;
    }

    static TextView text(Context c, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    static TextView heading(Context c, String s) {
        TextView t = text(c, s.toUpperCase(), 12, MUTED, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(0, dp(c, 18), 0, dp(c, 8));
        return t;
    }

    static Button button(Context c, String s, boolean primary) {
        Button b = new Button(c);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, primary ? 17 : 15);
        b.setTextColor(primary ? GOLD_INK : TEXT);
        b.setBackground(primary ? round(GOLD, 0, 10, c) : round(Color.TRANSPARENT, Color.parseColor("#4a5157"), 10, c));
        b.setStateListAnimator(null);
        int p = dp(c, primary ? 16 : 11);
        b.setPadding(p, p, p, p);
        return b;
    }

    static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(round(CARD, LINE, 12, c));
        int p = dp(c, 16);
        l.setPadding(p, p, p, p);
        return l;
    }

    static LinearLayout.LayoutParams wide(Context c, float topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(c, topDp);
        return lp;
    }

    static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    static View gap(Context c, float dp) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(c, dp), dp(c, dp)));
        return v;
    }
}
