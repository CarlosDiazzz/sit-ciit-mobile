import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

// Modo Nodo: el celular actúa como nodo de campo (sensores + outbox MQTT).
// Implementación real desde la Fase 1 (ver CLAUDE.md del repo).
export default function NodoScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Modo Nodo</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Text>Pendiente: pantalla de configuración, sensores y outbox (Fase 1+).</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: '80%',
  },
});
