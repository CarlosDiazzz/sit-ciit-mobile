import { useEffect, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

/** Mount once per new alarm; dismissing only silences this local notice. */
export default function AlarmNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { colors: c } = useZendaTheme();
  const player = useAudioPlayer(require('../../assets/alerts/alarm.wav'));
  const [soundError, setSoundError] = useState(false);
  useEffect(() => {
    let active = true;
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false })
      .then(() => {
        if (!active) return;
        player.loop = true;
        player.play();
      })
      .catch(() => { if (active) setSoundError(true); });
    // useAudioPlayer releases its player on unmount, including pending loads.
    return () => { active = false; player.pause(); };
  }, [player]);
  function dismiss() { player.pause(); onDismiss(); }
  return <Modal transparent animationType="fade" onRequestClose={dismiss}>
    <View style={s.backdrop}>
      <View accessibilityViewIsModal style={[s.card, { backgroundColor: c.bg }]}>
        <ScrollView contentContainerStyle={s.content}>
          <Image source={require('../../assets/alerts/danger.png')} style={s.icon} accessibilityLabel="Peligro" />
          <Text accessibilityRole="header" style={[s.title, { color: c.ink }]}>Alarma recibida</Text>
          <Text accessibilityRole="alert" style={[s.message, { color: c.ink }]}>{message}</Text>
          <Text style={[s.note, { color: c.muted }]}>{soundError ? 'No se pudo reproducir el sonido. Revisa el audio del dispositivo.' : 'Revisa el evento y el estado de la unidad.'}</Text>
          <Pressable accessibilityRole="button" onPress={dismiss} style={s.button}><Text style={s.buttonText}>Silenciar y cerrar</Text></Pressable>
          <Text style={[s.note, { color: c.muted }]}>Cerrar este aviso no detiene la alarma de la unidad.</Text>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}
const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(12,18,28,0.65)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 400, maxHeight: '90%', borderRadius: 24, borderTopWidth: 4, borderTopColor: '#C62828', overflow: 'hidden' },
  content: { padding: 24, alignItems: 'center', gap: 16 },
  icon: { width: 80, height: 80 }, title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 16, lineHeight: 24, textAlign: 'center' }, note: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  button: { backgroundColor: '#C62828', minHeight: 48, width: '100%', borderRadius: 12, padding: 14, alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
});
