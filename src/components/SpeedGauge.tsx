import { StyleSheet, Text, View } from 'react-native';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

export default function SpeedGauge({ speedKmh, label }: { speedKmh: number | null; label?: string }) {
  const { colors: c } = useZendaTheme();
  return <View accessible accessibilityLabel={`Velocidad: ${speedKmh == null ? 'sin dato' : speedKmh.toFixed(1) + ' kilómetros por hora'}. ${label ?? ''}`} style={s.container}>
    <View style={s.dial}>
      {Array.from({ length: 41 }, (_, i) => {
        const angle = (145 + i * 6.25) * Math.PI / 180;
        const active = speedKmh != null && i / 40 <= Math.min(speedKmh / 120, 1);
        return <View key={i} style={{ position: 'absolute', left: 126 + Math.cos(angle) * 112, top: 123 + Math.sin(angle) * 112, width: i % 5 === 0 ? 19 : 11, height: 4, borderRadius: 3, backgroundColor: active ? c.accent : c.line, transform: [{ rotate: `${angle}rad` }] }} />;
      })}
      <View style={s.center}><Text style={[s.caption, { color: c.muted }]}>VELOCIDAD</Text><Text style={[s.value, { color: c.ink }]}>{speedKmh == null ? '—' : speedKmh.toFixed(1)}</Text><Text style={{ fontSize: 14, color: c.muted }}>km/h</Text></View>
      <Text style={[s.zero, { color: c.muted }]}>0</Text><Text style={[s.max, { color: c.muted }]}>120</Text>
    </View>
    <Text style={[s.source, { color: c.muted }]}>{label ?? 'Esperando ubicación'}</Text>
  </View>;
}
const s = StyleSheet.create({ container: { alignItems: 'center' }, dial: { width: 270, height: 221 }, center: { position: 'absolute', top: 68, left: 0, right: 0, alignItems: 'center' }, caption: { fontSize: 10, letterSpacing: 2, fontWeight: '700' }, value: { fontSize: 64, lineHeight: 77, letterSpacing: -3, fontWeight: '700', fontVariant: ['tabular-nums'] }, zero: { position: 'absolute', left: 23, bottom: 4, fontSize: 11 }, max: { position: 'absolute', right: 20, bottom: 4, fontSize: 11 }, source: { fontSize: 11, marginTop: 4, marginBottom: 14 } });
