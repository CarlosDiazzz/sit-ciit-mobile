import { Image, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

export function BrandHeader() {
  const { colors: c, toggle } = useZendaTheme();
  return <View style={s.header}>
    <View style={s.brand}>
      <Image source={c.dark ? require('../../zendaLogoOscuro.png') : require('../../LogoClaro.png')} style={s.logo} accessibilityLabel="Logo de Zenda" resizeMode="contain" />
      <View><Text style={[s.wordmark, { color: c.ink }]}>zenda<Text style={{ color: c.gold }}>.</Text></Text><Text style={[s.brandCaption, { color: c.muted }]}>CONECTAMOS EL CAMINO</Text></View>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={c.dark ? 'Activar modo claro' : 'Activar modo oscuro'} onPress={toggle} style={[s.themeButton, { borderColor: c.line, backgroundColor: c.card }]}><Text style={{ color: c.ink, fontSize: 23 }}>{c.dark ? '☀' : '☾'}</Text></Pressable>
  </View>;
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { colors: c } = useZendaTheme();
  return <View style={[s.card, { backgroundColor: c.card, borderColor: c.line }, style]}>{children}</View>;
}
export function Heading({ title, eyebrow, aside }: { title: string; eyebrow?: string; aside?: string }) {
  const { colors: c } = useZendaTheme();
  return <View style={s.heading}><View style={{ flex: 1 }}>{eyebrow && <Text style={[s.eyebrow, { color: c.gold }]}>{eyebrow}</Text>}<Text style={[s.headingText, { color: c.ink }]}>{title}</Text></View>{aside && <Text style={[s.small, { color: c.muted }]}>{aside}</Text>}</View>;
}
export function Action({ title, onPress, disabled, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  const { colors: c } = useZendaTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.action, { backgroundColor: secondary ? c.soft : '#782D40', opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}><Text style={{ fontWeight: '700', color: secondary ? c.accent : '#FFF', textAlign: 'center' }}>{title}</Text></Pressable>;
}
export function Footer() {
  const { colors: c } = useZendaTheme();
  return <View style={s.footer}><View style={{ width: 30, height: 3, backgroundColor: c.gold, marginBottom: 12 }} /><Text style={[s.small, { color: c.muted }]}>ZENDA · INTELIGENCIA EN MOVIMIENTO</Text><Text style={[s.small, { color: c.muted, marginTop: 5 }]}>Sistema de monitoreo · Corredor Interoceánico</Text></View>;
}
const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 }, logo: { width: 54, height: 54 }, wordmark: { fontSize: 34, fontWeight: '800', letterSpacing: -1.7 }, brandCaption: { fontSize: 7, fontWeight: '700', letterSpacing: 1.5 }, themeButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 24, padding: 20, marginBottom: 14 }, heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 18 }, headingText: { fontSize: 18, fontWeight: '700', letterSpacing: -0.4 }, eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, marginBottom: 8 }, small: { fontSize: 10, lineHeight: 16 }, action: { minHeight: 48, borderRadius: 14, padding: 14, justifyContent: 'center' }, footer: { alignItems: 'center', paddingVertical: 28 },
});
