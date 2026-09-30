import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { BrandHeader, Card, Footer, Heading, Action } from '@/src/components/ZendaUI';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

export default function OperadorScreen() {
  const { colors: c } = useZendaTheme();
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: c.bg }}><ScrollView contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 620, alignSelf: 'center' }}><BrandHeader /><Text style={{ fontSize: 32, fontWeight: '700', color: c.ink, marginBottom: 8 }}>Centro de operación</Text><Text style={{ color: c.muted, lineHeight: 22, marginBottom: 25 }}>Información clara para acompañar cada recorrido.</Text><Card><View style={{ backgroundColor: c.soft, borderRadius: 20, width: 64, height: 64, alignItems: 'center', justifyContent: 'center', marginBottom: 22 }}><Text style={{ color: c.accent, fontSize: 32 }}>♙</Text></View><Heading eyebrow="PRÓXIMAMENTE" title="Todo conectado. Todo a la vista." /><Text style={{ color: c.muted, fontSize: 14, lineHeight: 23 }}>El acceso de operadores está en desarrollo. Aquí podrás consultar alertas y atender eventos de las unidades asignadas.</Text>{['Acceso con tu cuenta de operador', 'Alertas y eventos en tiempo real', 'Control autorizado de alarmas'].map((t, i) => <View key={t} style={{ flexDirection: 'row', gap: 14, paddingVertical: 19, borderBottomWidth: 1, borderColor: c.line }}><Text style={{ color: c.gold, fontWeight: '700' }}>0{i + 1}</Text><Text style={{ flex: 1, color: c.ink, fontSize: 13 }}>{t}</Text></View>)}<View style={{ marginTop: 24 }}><Action title="Ir al monitoreo" onPress={() => router.navigate('/(tabs)')} /></View></Card><Footer /></ScrollView></SafeAreaView>;
}
