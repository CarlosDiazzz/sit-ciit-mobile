import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

// Modo Operador: login, alertas en vivo, trigger/stop alarm.
// Implementación real desde la Fase 6 (ver CLAUDE.md del repo).
export default function OperadorScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Modo Operador</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Text>Pendiente: login, alertas en vivo y control de alarma (Fase 6).</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111111',
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: '80%',
  },
});
