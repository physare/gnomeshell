package com.gnomeshell.scan;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Size;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Taking the photos. The phone's motion sensors say which way it's looking:
 * how far down (which ring) and how far round the object (which slice). In
 * Auto, a photo is taken by itself each time the phone is held still over a
 * slice that has no photo yet. Every photo is checked for blur.
 */
public class CaptureActivity extends Activity implements SensorEventListener {
    private static final int ASK_CAMERA = 7;
    private File scan;
    private TextureView tv;
    private DialView dial;
    private Button autoBtn;
    private boolean auto = true;

    private HandlerThread camThread;
    private Handler camH;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private CameraDevice cam;
    private CameraCaptureSession session;
    private ImageReader jpeg;
    private Size previewSize, jpegSize;
    private CaptureRequest.Builder previewReq;

    private SensorManager sm;
    private final float[] rot = new float[9];
    private float az0 = Float.NaN, curAz, curDown;
    private float spin = 1f;
    private long stillSince;
    private long lastShot;
    private volatile boolean shooting;
    private int next = 1;
    private int pendingRing = -1, pendingSeg = -1;
    private final List<Double> sharp = Collections.synchronizedList(new ArrayList<Double>());
    private final List<JSONObject> shots = new ArrayList<>();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        scan = new File(getIntent().getStringExtra("scan"));
        next = Store.photos(scan).length + 1;

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff000000);
        tv = new TextureView(this);
        int w = getResources().getDisplayMetrics().widthPixels;
        root.addView(tv, new FrameLayout.LayoutParams(w, w * 4 / 3, Gravity.TOP));
        dial = new DialView(this);
        dial.count = next - 1;
        root.addView(dial, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        LinearLayout bar = Ui.row(this);
        bar.setGravity(Gravity.CENTER);
        int p = Ui.dp(this, 16);
        bar.setPadding(p, p, p, Ui.dp(this, 26));
        bar.setBackgroundColor(0xcc16181a);
        autoBtn = Ui.button(this, "Auto: on", false);
        autoBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                auto = !auto;
                autoBtn.setText(auto ? "Auto: on" : "Auto: off");
            }
        });
        Button shutter = new Button(this);
        shutter.setBackground(Ui.round(Ui.GOLD, 0xffffffff, 40, this));
        shutter.setStateListAnimator(null);
        shutter.setContentDescription("Take a photo");
        shutter.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { shoot(true); }
        });
        Button done = Ui.button(this, "Done", false);
        done.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { finishScan(); }
        });
        LinearLayout.LayoutParams side = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        bar.addView(autoBtn, side);
        LinearLayout.LayoutParams mid = new LinearLayout.LayoutParams(Ui.dp(this, 76), Ui.dp(this, 76));
        mid.leftMargin = mid.rightMargin = Ui.dp(this, 22);
        bar.addView(shutter, mid);
        bar.addView(done, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        root.addView(bar, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        setContentView(root);
        bar.post(new Runnable() {
            public void run() {
                float top = bar.getTop();
                float d = getResources().getDisplayMetrics().density;
                dial.setDialCenterY(top - Ui.dp(CaptureActivity.this, 20) - Math.min(dial.getWidth() * 0.3f, 120 * d) * 1.25f);
            }
        });
        tv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) {
                if (cam == null && camH != null) openCamera();
            }
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) { }
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
            public void onSurfaceTextureUpdated(SurfaceTexture s) { }
        });
        sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        hint("Stand the object on the scan sheet", Ui.TEXT);
    }

    @Override
    protected void onResume() {
        super.onResume();
        camThread = new HandlerThread("camera");
        camThread.start();
        camH = new Handler(camThread.getLooper());
        Sensor rv = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rv == null) rv = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rv != null) sm.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
        Sensor gy = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gy != null) sm.registerListener(this, gy, SensorManager.SENSOR_DELAY_GAME);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, ASK_CAMERA);
        } else if (tv.isAvailable()) {
            openCamera();
        }  // otherwise the TextureView's listener opens it once its surface is ready
    }

    @Override
    protected void onPause() {
        sm.unregisterListener(this);
        closeCamera();
        camThread.quitSafely();
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == ASK_CAMERA) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
                if (tv.isAvailable()) openCamera();
            } else {
                hint("GnomeShell Scan needs the camera to take the photos", Ui.BAD);
            }
        }
    }

    // ------------------------------------------------------------ camera

    private static Size pick(Size[] sizes, long maxArea, int maxW) {
        Size best = null;
        for (Size s : sizes) {
            boolean fourThree = s.getWidth() * 3 == s.getHeight() * 4;
            long a = (long) s.getWidth() * s.getHeight();
            if (!fourThree || a > maxArea || s.getWidth() > maxW) continue;
            if (best == null || a > (long) best.getWidth() * best.getHeight()) best = s;
        }
        if (best == null) {
            for (Size s : sizes) {
                long a = (long) s.getWidth() * s.getHeight();
                if (a > maxArea || s.getWidth() > maxW) continue;
                if (best == null || a > (long) best.getWidth() * best.getHeight()) best = s;
            }
        }
        return best != null ? best : sizes[0];
    }

    private void openCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        CameraManager mgr = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            String id = null;
            for (String c : mgr.getCameraIdList()) {
                Integer f = mgr.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (f != null && f == CameraCharacteristics.LENS_FACING_BACK) { id = c; break; }
            }
            if (id == null) id = mgr.getCameraIdList()[0];
            StreamConfigurationMap map = mgr.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            jpegSize = pick(map.getOutputSizes(ImageFormat.JPEG), 13_000_000L, 100000);
            previewSize = pick(map.getOutputSizes(SurfaceTexture.class), 1920L * 1440, 1920);
            jpeg = ImageReader.newInstance(jpegSize.getWidth(), jpegSize.getHeight(), ImageFormat.JPEG, 3);
            jpeg.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                public void onImageAvailable(ImageReader r) { saveImage(r); }
            }, camH);
            mgr.openCamera(id, new CameraDevice.StateCallback() {
                public void onOpened(CameraDevice d) { cam = d; startPreview(); }
                public void onDisconnected(CameraDevice d) { d.close(); cam = null; }
                public void onError(CameraDevice d, int e) {
                    d.close();
                    cam = null;
                    hint("The camera couldn't open (error " + e + ")", Ui.BAD);
                }
            }, camH);
        } catch (Exception e) {
            hint("The camera couldn't open: " + e.getMessage(), Ui.BAD);
        }
    }

    @SuppressWarnings("deprecation")
    private void startPreview() {
        try {
            SurfaceTexture st = tv.getSurfaceTexture();
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            final Surface ps = new Surface(st);
            previewReq = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewReq.addTarget(ps);
            previewReq.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            previewReq.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            cam.createCaptureSession(Arrays.asList(ps, jpeg.getSurface()), new CameraCaptureSession.StateCallback() {
                public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try { s.setRepeatingRequest(previewReq.build(), null, camH); } catch (Exception ignored) { }
                }
                public void onConfigureFailed(CameraCaptureSession s) {
                    hint("The camera couldn't start", Ui.BAD);
                }
            }, camH);
        } catch (CameraAccessException e) {
            hint("The camera couldn't start: " + e.getMessage(), Ui.BAD);
        }
    }

    private void closeCamera() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        session = null;
        if (cam != null) cam.close();
        cam = null;
        if (jpeg != null) jpeg.close();
        jpeg = null;
    }

    private void shoot(boolean byHand) {
        if (session == null || cam == null || shooting) return;
        if (!byHand && System.currentTimeMillis() - lastShot < 700) return;
        shooting = true;
        lastShot = System.currentTimeMillis();
        if (Float.isNaN(az0)) az0 = curAz;   // the first photo is 0 degrees round
        dial.started = true;
        pendingRing = dial.ring;
        pendingSeg = dial.ring >= 0 ? DialView.segmentOf(dial.ring, rel(curAz)) : -1;
        try {
            CaptureRequest.Builder r = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            r.addTarget(jpeg.getSurface());
            r.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            r.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            r.set(CaptureRequest.JPEG_ORIENTATION, 0);   // every photo the same way round, so they share one lens
            r.set(CaptureRequest.JPEG_QUALITY, (byte) 92);
            session.capture(r.build(), null, camH);
            dial.flash = true;
            dial.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            dial.invalidate();
        } catch (Exception e) {
            shooting = false;
        }
    }

    private void saveImage(ImageReader r) {
        Image img = r.acquireNextImage();
        if (img == null) { shooting = false; return; }
        final int ringAt = pendingRing, segAt = pendingSeg;
        final float down = curDown, az = rel(curAz);
        final File f = new File(scan, String.format(java.util.Locale.US, "IMG_%03d.jpg", next++));
        try {
            ByteBuffer buf = img.getPlanes()[0].getBuffer();
            byte[] b = new byte[buf.remaining()];
            buf.get(b);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(b); }
        } catch (Exception e) {
            shooting = false;
            return;
        } finally {
            img.close();
        }
        // blur check, on this (camera) thread: the photo shrunk 8 times
        double s = sharpness(f);
        double med = median();
        boolean blurry = sharp.size() >= 5 && s < 0.4 * med;
        if (blurry) {
            f.delete();
            next--;
            hintFor("That one was blurry. Hold still for a moment.", Ui.BAD, 2200);
        } else {
            sharp.add(s);
            try {
                JSONObject j = new JSONObject();
                j.put("file", f.getName());
                j.put("ring", ringAt);
                j.put("deg", Math.round(az));
                j.put("down", Math.round(down));
                synchronized (shots) { shots.add(j); }
            } catch (Exception ignored) { }
        }
        ui.post(new Runnable() {
            public void run() {
                if (!blurry && ringAt >= 0 && segAt >= 0) dial.taken[ringAt][segAt] = true;
                dial.count = Store.photos(scan).length;
                dial.invalidate();
                shooting = false;
            }
        });
    }

    private static double sharpness(File f) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = 8;
        Bitmap bm = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
        if (bm == null) return 0;
        int w = bm.getWidth(), h = bm.getHeight();
        int x0 = w / 5, y0 = h / 5, x1 = w - w / 5, y1 = h - h / 5;
        int[] px = new int[w * h];
        bm.getPixels(px, 0, w, 0, 0, w, h);
        bm.recycle();
        double sum = 0, sum2 = 0;
        int n = 0;
        for (int y = y0 + 1; y < y1 - 1; y++) {
            for (int x = x0 + 1; x < x1 - 1; x++) {
                double l = 4 * g(px[y * w + x]) - g(px[y * w + x - 1]) - g(px[y * w + x + 1]) - g(px[(y - 1) * w + x]) - g(px[(y + 1) * w + x]);
                sum += l;
                sum2 += l * l;
                n++;
            }
        }
        if (n == 0) return 0;
        double m = sum / n;
        return sum2 / n - m * m;
    }

    private static double g(int c) {
        return 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
    }

    private double median() {
        synchronized (sharp) {
            if (sharp.isEmpty()) return 0;
            List<Double> s = new ArrayList<>(sharp);
            Collections.sort(s);
            return s.get(s.size() / 2);
        }
    }

    // ------------------------------------------------------------ motion

    private float rel(float az) {
        return Float.isNaN(az0) ? 0 : az - az0;
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            float m = (float) Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
            spin = 0.8f * spin + 0.2f * m;
            if (spin > 0.12f) stillSince = 0;
            else if (stillSince == 0) stillSince = System.currentTimeMillis();
            return;
        }
        SensorManager.getRotationMatrixFromVector(rot, e.values);
        // the back camera looks along the phone's -z
        float fx = -rot[2], fy = -rot[5], fz = -rot[8];
        curDown = (float) Math.toDegrees(Math.asin(Math.max(-1f, Math.min(1f, -fz))));
        curAz = (float) Math.toDegrees(Math.atan2(fx, fy));
        int ring = curDown < 5 ? -1 : curDown < 35 ? 0 : curDown < 58 ? 1 : curDown < 88 ? 2 : -1;
        dial.ring = ring;
        dial.azimuth = rel(curAz);
        if (hintUntil < System.currentTimeMillis()) {
            if (!dial.started) hint(auto ? "Point at the object and hold still" : "Point at the object and tap the gold button", Ui.TEXT);
            else if (curDown < 5) hint("Tilt the phone down toward the object", Ui.GOLD);
            else if (curDown >= 88) hint("Too steep: tilt back a little", Ui.GOLD);
            else if (dial.currentTaken()) hint(nextHint(), Ui.TEXT);
            else if (spin > 0.12f) hint("Hold still…", Ui.TEXT);
            else hint(auto ? "Taking…" : "Tap to take this one", Ui.OK);
        }
        if (auto && !shooting && ring >= 0 && (!dial.started || !dial.currentTaken())
                && stillSince > 0 && System.currentTimeMillis() - stillSince > 350) {
            shoot(false);
        }
        dial.invalidate();
    }

    private String nextHint() {
        int ring = dial.ring;
        if (ring < 0) return "";
        int n = DialView.SEGMENTS[ring], have = 0;
        for (boolean b : dial.taken[ring]) if (b) have++;
        if (have < n) return "Step round to the next gap";
        for (int k = 0; k < 3; k++) {
            int c = 0;
            for (boolean b : dial.taken[k]) if (b) c++;
            if (c < DialView.SEGMENTS[k]) return k < ring ? "This ring's done: go lower" : "This ring's done: go higher";
        }
        return "All done! Tap Done";
    }

    @Override
    public void onAccuracyChanged(Sensor s, int a) { }

    private long hintUntil;

    private void hint(final String s, final int color) {
        ui.post(new Runnable() {
            public void run() {
                dial.hint = s;
                dial.hintColor = color;
                dial.invalidate();
            }
        });
    }

    private void hintFor(String s, int color, long ms) {
        hintUntil = System.currentTimeMillis() + ms;
        hint(s, color);
    }

    // ------------------------------------------------------------ done

    private void finishScan() {
        final int n = Store.photos(scan).length;
        if (n < 25) {
            new AlertDialog.Builder(this)
                    .setTitle("Only " + n + " photos")
                    .setMessage("Scans come out best with 40 or more, from all three rings. Keep going?")
                    .setPositiveButton("Keep taking", null)
                    .setNegativeButton(n == 0 ? "Leave" : "Finish anyway", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d, int w) { done(n); }
                    })
                    .show();
            return;
        }
        done(n);
    }

    private void done(int n) {
        if (n == 0) {
            Store.delete(scan);
            finish();
            return;
        }
        try {
            JSONObject cap = new JSONObject();
            JSONArray a = new JSONArray();
            synchronized (shots) { for (JSONObject j : shots) a.put(j); }
            cap.put("shots", a);
            cap.put("coverage", dial.filled() + "/" + dial.total());
            cap.put("size", jpegSize == null ? "" : jpegSize.getWidth() + "x" + jpegSize.getHeight());
            Store.put(scan, "capture", cap);
        } catch (Exception ignored) { }
        Store.put(scan, "state", "taken");
        Intent i = new Intent(this, ScanActivity.class);
        i.putExtra("scan", scan.getAbsolutePath());
        i.putExtra("send", true);
        startActivity(i);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishScan();
    }
}
