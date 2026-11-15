import { NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { ProgressSink } from '../core/ports';

// The platform half of download notifications; the throttling is in src/core/downloadNotifier.ts.
// Android: native module with setProgress() fill bar + setOngoing(true).
// iOS: expo-notifications (no progress bar support, just start/finish text).
const Native = NativeModules.DownloadNotification as {
  start: () => void;
  update: (done: number, total: number) => void;
  finish: (total: number) => void;
  dismiss: () => void;
} | undefined;

const NOTIF_ID = 'nous-download-progress';
const DISMISS_AFTER_MS = 8000;

/** One sink per download run; the iOS permission answer lives in this instance. */
export function createPlatformProgressSink(): ProgressSink {
  let iosPermissionGranted = false;

  return {
    async start() {
      iosPermissionGranted = false;
      if (Platform.OS === 'android') {
        // Permission is handled by expo-notifications (POST_NOTIFICATIONS on API 33+).
        // Request it here so the native module can notify immediately.
        await Notifications.requestPermissionsAsync().catch(() => {});
        Native?.start();
        return;
      }

      // iOS fallback: plain text notification, start only.
      try {
        const { status } = await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: false, allowSound: false },
        });
        iosPermissionGranted = status === 'granted';
        if (!iosPermissionGranted) return;
        await Notifications.scheduleNotificationAsync({
          identifier: NOTIF_ID,
          content: { title: 'Nous', body: 'Downloading library…' },
          trigger: null,
        });
      } catch {}
    },

    update(done, total) {
      if (Platform.OS === 'android') Native?.update(done, total);
      // iOS: skip intermediate updates — trigger:null notifications stack.
    },

    async finish(total) {
      if (Platform.OS === 'android') {
        Native?.finish(total);
        setTimeout(() => Native?.dismiss(), DISMISS_AFTER_MS);
        return;
      }

      if (!iosPermissionGranted) return;
      try {
        await Notifications.dismissNotificationAsync(NOTIF_ID).catch(() => {});
        await Notifications.scheduleNotificationAsync({
          identifier: NOTIF_ID,
          content: { title: 'Nous', body: `Library ready — ${total} articles` },
          trigger: null,
        });
        setTimeout(() => Notifications.dismissNotificationAsync(NOTIF_ID).catch(() => {}), DISMISS_AFTER_MS);
      } catch {}
    },
  };
}
