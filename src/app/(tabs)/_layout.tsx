import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useZendaTheme();
  return <Tabs initialRouteName="index" screenOptions={{ headerShown: false, tabBarActiveTintColor: c.accent, tabBarInactiveTintColor: c.muted, tabBarStyle: { backgroundColor: c.card, borderTopColor: c.line, paddingTop: 10, paddingBottom: Math.max(12, insets.bottom), height: 60 + Math.max(12, insets.bottom) }, tabBarLabelStyle: { fontSize: 11, fontWeight: '600' }, tabBarLabelPosition: 'below-icon', tabBarHideOnKeyboard: true }}>
    <Tabs.Screen name="index" options={{ title: 'Monitoreo', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 24 }}>◉</Text> }} />
    <Tabs.Screen name="operador" options={{ title: 'Operador', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 24 }}>♙</Text> }} />
  </Tabs>;
}
