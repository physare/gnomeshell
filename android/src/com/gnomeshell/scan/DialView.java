package com.gnomeshell.scan;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * The coverage dial over the camera view: three rings, seen from above. The
 * outer ring is photos from low down (looking across at the object), the inner
 * ring photos from high up (looking down on it). Each slice fills in gold once
 * it has a photo. The white marker is where the phone is now.
 */
class DialView extends View {
    static final int[] SEGMENTS = {24, 16, 10};
    final boolean[][] taken = {new boolean[24], new boolean[16], new boolean[10]};
    int ring = -1;          // the ring the phone is on now, -1 when it's too level or too steep
    float azimuth;          // degrees round the object, relative to the first photo
    boolean started;        // a first photo sets where 0 degrees is
    String hint = "";
    int hintColor = Ui.TEXT;
    int count;
    boolean flash;

    private final Paint seg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint txt = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF r = new RectF();
    private float dialCy = -1;

    DialView(Context c) {
        super(c);
        seg.setStyle(Paint.Style.STROKE);
        seg.setStrokeCap(Paint.Cap.BUTT);
        txt.setTextAlign(Paint.Align.CENTER);
        txt.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
    }

    void setDialCenterY(float y) { dialCy = y; invalidate(); }

    static int segmentOf(int ring, float az) {
        int n = SEGMENTS[ring];
        float a = ((az % 360f) + 360f) % 360f;
        return Math.min(n - 1, (int) (a / (360f / n)));
    }

    boolean currentTaken() {
        return ring >= 0 && started && taken[ring][segmentOf(ring, azimuth)];
    }

    int filled() {
        int k = 0;
        for (boolean[] t : taken) for (boolean b : t) if (b) k++;
        return k;
    }

    int total() { return SEGMENTS[0] + SEGMENTS[1] + SEGMENTS[2]; }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        float d = getResources().getDisplayMetrics().density;
        if (flash) {
            c.drawColor(Color.argb(90, 255, 255, 255));
            flash = false;
        }
        // the hint along the top
        txt.setTextSize(17 * d);
        txt.setColor(hintColor);
        bg.setColor(Color.argb(170, 22, 24, 26));
        float hw = Math.min(w - 24 * d, txt.measureText(hint) + 32 * d);
        if (!hint.isEmpty()) {
            r.set(w / 2 - hw / 2, 18 * d, w / 2 + hw / 2, 58 * d);
            c.drawRoundRect(r, 20 * d, 20 * d, bg);
            c.drawText(hint, w / 2, 44 * d, txt);
        }

        // the dial
        float cy = dialCy > 0 ? dialCy : h - 230 * d;
        float cx = w / 2;
        float R0 = Math.min(w * 0.3f, 120 * d);
        float thick = R0 * 0.22f;
        r.set(cx - R0 - thick, cy - R0 - thick, cx + R0 + thick, cy + R0 + thick);
        bg.setColor(Color.argb(150, 22, 24, 26));
        c.drawOval(r, bg);
        seg.setStrokeWidth(thick * 0.82f);
        for (int k = 0; k < 3; k++) {
            float rad = R0 - k * thick * 1.05f;
            r.set(cx - rad, cy - rad, cx + rad, cy + rad);
            int n = SEGMENTS[k];
            float step = 360f / n;
            for (int i = 0; i < n; i++) {
                seg.setColor(taken[k][i] ? Ui.GOLD : Color.argb(130, 140, 147, 152));
                // 0 degrees at the bottom of the dial (nearest you), going round clockwise like your walk
                c.drawArc(r, 90 + i * step + 1.2f, step - 2.4f, false, seg);
            }
            if (k == ring && started) {
                int i = segmentOf(k, azimuth);
                seg.setColor(Color.WHITE);
                Paint.Style s = seg.getStyle();
                seg.setStrokeWidth(thick * 0.35f);
                c.drawArc(r, 90 + i * step + 1.2f, step - 2.4f, false, seg);
                seg.setStrokeWidth(thick * 0.82f);
                seg.setStyle(s);
            }
        }
        // the middle: how many photos
        txt.setColor(Ui.TEXT);
        txt.setTextSize(26 * d);
        c.drawText(String.valueOf(count), cx, cy + 6 * d, txt);
        txt.setTextSize(11 * d);
        txt.setColor(Ui.MUTED);
        c.drawText(count == 1 ? "photo" : "photos", cx, cy + 22 * d, txt);
        // ring names
        txt.setTextSize(11 * d);
        txt.setColor(Color.argb(200, 232, 230, 225));
        c.drawText("low · middle · high", cx, cy - R0 - thick - 8 * d, txt);
    }
}
