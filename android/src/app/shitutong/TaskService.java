package app.shitutong;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

// 长任务（识图、建模、改模型）期间的前台服务：通知栏显示进度，保持 CPU 和 Wi-Fi 不休眠，
// 这样切到后台或锁屏时网络请求和计算都能继续；任务结束就停掉。
public class TaskService extends Service {
    static final String CH_WORK = "work", CH_DONE = "done";
    static final int ID_WORK = 7, ID_DONE = 8;
    PowerManager.WakeLock cpu;
    WifiManager.WifiLock wifi;
    boolean started;
    static volatile boolean running;

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CH_WORK) == null) {
            NotificationChannel w = new NotificationChannel(CH_WORK, "识图建模进度", NotificationManager.IMPORTANCE_LOW);
            w.setDescription("识图、建模进行中时显示，切到后台也会继续");
            w.setShowBadge(false);
            nm.createNotificationChannel(w);
        }
        if (nm.getNotificationChannel(CH_DONE) == null) {
            NotificationChannel d = new NotificationChannel(CH_DONE, "完成提醒", NotificationManager.IMPORTANCE_DEFAULT);
            d.setDescription("识图建模完成时提醒");
            nm.createNotificationChannel(d);
        }
    }

    static PendingIntent open(Context c) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    @SuppressWarnings("deprecation")
    static Notification build(Context c, String channel, String title, String text, boolean ongoing) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        b.setSmallIcon(android.R.drawable.stat_notify_sync)
         .setContentTitle(title)
         .setContentText(text)
         .setStyle(new Notification.BigTextStyle().bigText(text))
         .setContentIntent(open(c))
         .setOngoing(ongoing)
         .setAutoCancel(!ongoing)
         .setOnlyAlertOnce(true);
        if (ongoing) b.setProgress(0, 0, true);
        return b.build();
    }

    // 更新进度文字
    static void update(Context c, String text) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        try { nm.notify(ID_WORK, build(c, CH_WORK, "视图通正在工作", text == null || text.isEmpty() ? "正在处理…" : text, true)); } catch (Exception ignored) { }
    }

    // 任务完成的提醒（App 不在前台时由网页调用）
    static void done(Context c, String title, String text) {
        channels(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        try { nm.notify(ID_DONE, build(c, CH_DONE, title, text, false)); } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "正在处理…";
        channels(this);
        Notification n = build(this, CH_WORK, "视图通正在工作", text, true);
        if (!started) {
            try {
                if (Build.VERSION.SDK_INT >= 29) startForeground(ID_WORK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                else startForeground(ID_WORK, n);
                started = true; running = true;
            } catch (Exception e) {
                // 某些系统不允许此刻启动前台服务：退化为普通运行，至少不崩溃
                stopSelf();
                return START_NOT_STICKY;
            }
            hold();
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            try { nm.notify(ID_WORK, n); } catch (Exception ignored) { }
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    void hold() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shitutong:task");
            cpu.acquire(20 * 60 * 1000L); // 最长 20 分钟，防止忘记释放
        } catch (Exception ignored) { }
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            wifi = wm.createWifiLock(Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "shitutong:task");
            wifi.acquire();
        } catch (Exception ignored) { }
    }

    void stopAll() {
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) { }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { }
        cpu = null; wifi = null; running = false;
        if (started) { if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true); }
        started = false;
        stopSelf();
    }

    @Override
    public void onDestroy() { stopAll(); super.onDestroy(); }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
