import { useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';

/** Closing unmounts this notice; useAudioPlayer owns audio teardown. */
export default function AlarmNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const player = useAudioPlayer(require('../../assets/alerts/alarm.wav'));
  const dismissed = useRef(false);
  const [soundError, setSoundError] = useState(false);
  useEffect(() => {
    let active = true;
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false })
      .then(() => {
        if (!active || dismissed.current) return;
        player.loop = true;
        player.play();
      })
      .catch(() => { if (active && !dismissed.current) setSoundError(true); });
    // Expo releases the native player before this cleanup. Do not call its methods here.
    return () => { active = false; };
  }, [player]);
  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    onDismiss();
  }
  return <Modal animationType="fade" presentationStyle="fullScreen" statusBarTranslucent navigationBarTranslucent onRequestClose={dismiss}>
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.content}>
        <View accessibilityViewIsModal style={s.notice}>
          <Image source={require('../../assets/alerts/danger-white.png')} style={s.icon} accessibilityLabel="Peligro" />
          <Text accessibilityRole="header" style={s.title}>Alarma recibida</Text>
          <Text accessibilityRole="alert" style={s.message}>{message}</Text>
          <Text style={s.note}>{soundError ? 'No se pudo reproducir el sonido. Revisa el audio del dispositivo.' : 'Revisa el evento y el estado de la unidad.'}</Text>
          <Pressable accessibilityRole="button" onPress={dismiss} style={({ pressed }) => [s.button, pressed && s.buttonPressed]}><Text style={s.buttonText}>Silenciar y cerrar</Text></Pressable>
          <Text style={s.note}>Cerrar este aviso no detiene la alarma de la unidad.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#C62828' },
  content: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  notice: { width: '100%', maxWidth: 480, alignItems: 'center', gap: 24 },
  icon: { width: 144, height: 144 },
  title: { color: '#FFF', fontSize: 32, fontWeight: '700', textAlign: 'center' },
  message: { color: '#FFF', fontSize: 18, lineHeight: 28, textAlign: 'center' },
  note: { color: '#FFF', fontSize: 14, lineHeight: 22, textAlign: 'center' },
  button: { backgroundColor: '#FFF', minHeight: 56, width: '100%', borderRadius: 14, padding: 18, alignItems: 'center', justifyContent: 'center' },
  buttonPressed: { backgroundColor: '#FFE5E5' },
  buttonText: { color: '#C62828', fontSize: 18, fontWeight: '700' },
});
