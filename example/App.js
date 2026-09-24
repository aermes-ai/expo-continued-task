import { useEffect, useState } from 'react';
import {
  AppState, Button, Platform, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as bg from '@aermes/expo-continued-task';
import { createContinuedJob } from '@aermes/expo-continued-task';

// The work: 120 units of about a second each (two minutes), so there is time to leave the app
// and watch the system banner. Replace `doOneUnit` with your own unit of work.
const UNITS = 120;
const UNIT_MS = 1000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function doOneUnit() {
  await sleep(UNIT_MS);
}

// Show the done / paused notifications even while the app is in front.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Progress the screen shows. The job keeps its own counts for the banner; this is for the UI.
let next = 0;
const listeners = new Set();
const publish = () => listeners.forEach((l) => l(next));

// Created once, at module scope: the job listens to AppState for the whole life of the app.
const job = createContinuedJob({
  name: 'example',
  bg,
  appState: AppState,
  // How many units this run owes. A run after a finished one starts over.
  size: () => {
    if (next >= UNITS) {
      next = 0;
      publish();
    }
    return UNITS - next;
  },
  // One unit; resolves false when none are left.
  step: async () => {
    await doOneUnit();
    next += 1;
    publish();
    return next < UNITS;
  },
  seedMs: UNIT_MS,
  words: {
    title: 'Example work',
    line: ({ done, total }) => `${done} of ${total}`,
    done: ({ total }) => `${total} units done`,
  },
  notifications: {
    Notifications,
    done: { title: 'Example work finished', body: `All ${UNITS} units are done` },
    paused: { title: 'Example work paused', body: 'Tap to resume' },
  },
});

export default function App() {
  const [done, setDone] = useState(next);
  const [running, setRunning] = useState(job.isRunning());
  const [status, setStatus] = useState('Idle');
  const [permission, setPermission] = useState('unknown');

  useEffect(() => {
    listeners.add(setDone);
    return () => { listeners.delete(setDone); };
  }, []);

  useEffect(() => {
    Notifications.requestPermissionsAsync()
      .then(({ status: s }) => setPermission(s))
      .catch(() => setPermission('unavailable'));
  }, []);

  // A tap on the paused notification opens the app; from there, resume is the person's action.
  useEffect(() => job.listen({
    open: () => {},
    top: () => {},
    resume: () => start(),
    canResume: () => !job.isRunning(),
  }), []);

  function start() {
    // From a tap, with the app in front: the only way a continued task is allowed to start.
    setRunning(true);
    setStatus('Running');
    job.start().then((result) => {
      setRunning(false);
      setStatus(result.complete ? 'Finished' : `Paused at ${next} of ${UNITS}`);
    });
  }

  function stop() {
    job.stop();
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="auto" />
      <View style={styles.body}>
        <Text style={styles.title}>expo-continued-task</Text>
        <Text style={styles.count}>{done} / {UNITS}</Text>
        <Text style={styles.line}>{status}</Text>
        <View style={styles.buttons}>
          <Button title="Start" onPress={start} disabled={running} />
          <Button title="Stop" onPress={stop} disabled={!running} />
        </View>
        <Text style={styles.meta}>isAvailable (native module linked): {String(bg.isAvailable)}</Text>
        <Text style={styles.meta}>continuedSupported() (iOS 26 continued task): {String(bg.continuedSupported())}</Text>
        <Text style={styles.meta}>notifications: {permission}</Text>
        <Text style={styles.hint}>
          {Platform.OS === 'ios'
            ? 'Tap Start, then leave the app. On iOS 26 the system shows a progress banner with a Stop button.'
            : 'iOS only: on this platform every call is a no-op and the work only runs in the foreground.'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  body: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  count: { fontSize: 48, fontVariant: ['tabular-nums'] },
  line: { fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 16 },
  meta: { fontSize: 13, opacity: 0.7 },
  hint: { fontSize: 13, opacity: 0.7, marginTop: 12 },
});
