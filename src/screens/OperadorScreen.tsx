import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import AlarmNotice from '@/src/components/AlarmNotice';
import { BrandHeader, Card, Heading, Action, Field, Footer } from '@/src/components/ZendaUI';
import { useZendaTheme } from '@/src/theme/ZendaTheme';
import { useSession } from '@/src/lib/session';
import { api, ApiError, type UnitSummary } from '@/src/lib/api';
import {
  getOperatorSocket,
  closeOperatorSocket,
  type EventBroadcast,
  type CommandUpdate,
  type NodeStatusUpdate,
} from '@/src/lib/operatorSocket';
import { OPERATOR_ALLOWED_ACTIONS, type CmdAction } from '@/src/contract/contract';

// Modo Operador: login contra sit-ciit-backend, alertas en vivo por
// Socket.IO y botones trigger_alarm/stop_alarm — mismos endpoints que
// ya usa sit-ciit-dashboard con este rol, no un canal nuevo (ver plan).
// Un mismo celular puede tener esta pestaña abierta junto con la de
// Nodo (ver CLAUDE.md del repo).

const ACCION_LABEL: Record<CmdAction, string> = {
  trigger_alarm: 'Activar alarma',
  stop_alarm: 'Detener alarma',
  set_sampling_rate: 'Ajustar muestreo',
  set_thresholds: 'Ajustar umbrales',
  set_mode: 'Cambiar modo',
  toggle_sensor: 'Activar/desactivar sensor',
};

const MAX_ALERTAS = 40;

/** Feed unificado: eventos reales de sensor (impact/door/rollover/
 *  signal_lost/etc.) MAS el resultado de una alarma activada/detenida
 *  por cualquiera (dashboard u otro operador) — trigger_alarm/stop_alarm
 *  son comandos, no eventos, asi que no llegaban por 'event' y por eso
 *  no se veian aqui aunque si se ejecutaran de verdad en el nodo. */
type Actividad =
  | { tipo: 'evento'; ts: number; data: EventBroadcast }
  | { tipo: 'comando'; ts: number; nodeId: string; status: 'executed' | 'rejected'; reason: string | null };

function haceCuanto(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

export default function OperadorScreen() {
  const { colors: c } = useZendaTheme();
  const { session, loading, apiUrl, setApiUrl, login, logout } = useSession();

  // --- Login ---
  const [email, setEmail] = useState('');
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  async function entrar() {
    setLoginError(null);
    setLoggingIn(true);
    try {
      await login(apiUrl.trim(), email.trim(), password);
      setPassword('');
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setLoggingIn(false);
    }
  }

  async function salir() {
    closeOperatorSocket();
    await logout();
    setUnidades([]);
    setAlertas([]);
    setNotice(null);
  }

  // --- Unidades (para elegir nodo destino) ---
  const [unidades, setUnidades] = useState<UnitSummary[]>([]);
  const [nodoDestino, setNodoDestino] = useState<string | null>(null);

  const cargarUnidades = useCallback(async () => {
    if (!session) return;
    try {
      const data = await api.listUnits(session.apiUrl, session.token);
      setUnidades(data);
    } catch {
      // Se reintenta en el siguiente pull-to-refresh; no bloquea el resto
      // de la pantalla (las alertas en vivo siguen llegando igual).
    }
  }, [session]);

  useEffect(() => {
    void cargarUnidades();
  }, [cargarUnidades]);

  // --- Estado de la conexion en vivo (sin esto no habia forma de saber
  // desde la pantalla si el socket seguia conectado o se habia caido). ---
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

  // --- Alertas y avances de comando en vivo ---
  const noticeSequence = useRef(0);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const [alertas, setAlertas] = useState<Actividad[]>([]);
  const [ultimoComando, setUltimoComando] = useState<{ cmdId: string; targetNodeCode: string; action: CmdAction } | null>(
    null,
  );
  const [avanceComando, setAvanceComando] = useState<CommandUpdate | null>(null);

  useEffect(() => {
    if (loading) return;
    const url = session?.apiUrl ?? publicUrl ?? apiUrl;
    const socket = getOperatorSocket(url.trim(), session?.token ?? null);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function onConnect() {
      clearTimeout(retryTimer);
      setSocketStatus('connected');
    }
    function onDisconnect() {
      setSocketStatus('error');
    }
    function onConnectError() {
      setSocketStatus('error');
      // Namespace rejections (including rate limits) need an explicit retry.
      if (!socket.active) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => socket.connect(), 60000);
      }
    }

    function onEvent(payload: EventBroadcast) {
      if (payload.severity !== 'info') {
        setNotice({ id: ++noticeSequence.current, message: `${payload.kind} · Unidad ${payload.unitId}${payload.nodeId ? ` · Nodo ${payload.nodeId}` : ''}` });
      }
      if (payload.severity === 'critical') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      setAlertas((prev) => [{ tipo: 'evento' as const, ts: payload.ts, data: payload }, ...prev].slice(0, MAX_ALERTAS));
    }
    function onCommandUpdate(payload: CommandUpdate) {
      setAvanceComando((prev) =>
        !ultimoComando || payload.cmdId !== ultimoComando.cmdId ? prev : payload,
      );
      // "executed"/"rejected" son el desenlace real de un comando
      // (activar/detener alarma) en el nodo — se muestran en el mismo
      // feed que los eventos aunque los haya mandado el dashboard u otro
      // operador, no solo los que este celular mismo envio. "delivered"
      // se omite: es solo un acuse a medio camino, no un desenlace.
      const desenlace = payload.status;
      if (desenlace === 'executed' || desenlace === 'rejected') {
        void Haptics.notificationAsync(
          desenlace === 'executed' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
        );
        setAlertas((prev) =>
          [
            {
              tipo: 'comando' as const,
              ts: payload.occurredAt,
              nodeId: payload.nodeId,
              status: desenlace,
              reason: payload.reason,
            },
            ...prev,
          ].slice(0, MAX_ALERTAS),
        );
      }
    }
    // El estado de /units es una foto del momento del login: sin esto,
    // un nodo que se conecta o se cae despues se queda mostrado con el
    // estado viejo para siempre (justo lo que se reporto como "aparecen
    // sin conexion" sin ser en vivo).
    function onNodeStatus(payload: NodeStatusUpdate) {
      setUnidades((prev) =>
        prev.map((u) =>
          u.unitCode !== payload.unitId
            ? u
            : {
                ...u,
                nodes: u.nodes.map((n) =>
                  n.nodeCode === payload.nodeId ? { ...n, isOnline: payload.isOnline } : n,
                ),
              },
        ),
      );
    }

    // Si el socket ya estaba conectado (se reutiliza el singleton entre
    // remontajes), 'connect' no vuelve a disparar — hay que leer el
    // estado actual, no solo esperar el proximo evento. Se defiere con
    // queueMicrotask (no setState sincrono dentro del efecto) siguiendo
    // la regla de react-hooks/set-state-in-effect.
    queueMicrotask(() => { if (socket.connected) onConnect(); else setSocketStatus('connecting'); });

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('event', onEvent);
    socket.on('command:update', onCommandUpdate);
    socket.on('node:status', onNodeStatus);
    return () => {
      clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('event', onEvent);
      socket.off('command:update', onCommandUpdate);
      socket.off('node:status', onNodeStatus);
      closeOperatorSocket();
    };
    // ultimoComando cambia con cada envío; no hace falta reabrir el
    // socket por eso, solo que el closure de onCommandUpdate lo vea.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loading, publicUrl]);

  // --- Emitir comando ---
  const [enviando, setEnviando] = useState(false);
  const [envioError, setEnvioError] = useState<string | null>(null);

  async function emitir(action: CmdAction) {
    if (!session || !nodoDestino) return;
    setEnvioError(null);
    setEnviando(true);
    try {
      const cmd = await api.issueCommand(session.apiUrl, session.token, nodoDestino, action);
      setUltimoComando({ cmdId: cmd.cmdId, targetNodeCode: cmd.targetNodeCode, action });
      setAvanceComando(null);
    } catch (err) {
      setEnvioError(err instanceof ApiError ? err.message : 'No se pudo enviar el comando.');
    } finally {
      setEnviando(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={c.accent} />
      </SafeAreaView>
    );
  }

  const nodos = unidades.flatMap((u) => u.nodes.map((n) => ({ ...n, unitLabel: u.label ?? u.unitCode })));
  const acciones = OPERATOR_ALLOWED_ACTIONS;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 620, alignSelf: 'center' }}>
        {notice && <AlarmNotice key={notice.id} message={notice.message} onDismiss={() => setNotice(null)} />}
        <BrandHeader />
        <Heading eyebrow="OPERADOR" title="Centro de operación" aside={session?.user.email ?? 'Alertas sin sesión'} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: socketStatus === 'connected' ? c.green : socketStatus === 'connecting' ? c.gold : c.accent,
            }}
          />
          <Text style={{ color: c.muted, fontSize: 12 }}>
            {socketStatus === 'connected'
              ? 'Conectado en vivo'
              : socketStatus === 'connecting'
                ? 'Conectando…'
                : 'Sin conexión con el servidor — reintentando'}
          </Text>
        </View>

        <Card>
          <Heading title="Alertas en vivo" aside={`${alertas.length}`} />
          {socketStatus !== 'connected' ? (
            <Text style={{ color: c.muted, fontSize: 13 }}>
              Esperando conexión con el servidor para recibir alertas en vivo…
            </Text>
          ) : alertas.length === 0 ? (
            <Text style={{ color: c.muted, fontSize: 13 }}>Sin alertas todavía. Aparecen en cuanto ocurre un evento o se active una alarma real.</Text>
          ) : (
            alertas.map((a, i) => {
              const critico = a.tipo === 'evento' ? a.data.severity === 'critical' : a.status === 'rejected';
              const color = critico ? c.accent : a.tipo === 'evento' && a.data.severity === 'warning' ? c.gold : c.green;
              const titulo =
                a.tipo === 'evento'
                  ? a.data.kind.replace(/_/g, ' ')
                  : a.status === 'executed'
                    ? 'Alarma / comando ejecutado'
                    : `Comando rechazado${a.reason ? ` — ${a.reason}` : ''}`;
              const detalle =
                a.tipo === 'evento'
                  ? `${a.data.unitId}${a.data.nodeId ? ` · ${a.data.nodeId}` : ''} · ${haceCuanto(a.ts)}`
                  : `${a.nodeId} · ${haceCuanto(a.ts)}`;
              return (
                <View
                  key={`${a.ts}-${i}`}
                  style={{
                    paddingVertical: 10,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderColor: c.line,
                    flexDirection: 'row',
                    gap: 10,
                    alignItems: 'flex-start',
                  }}
                >
                  <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: color }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.ink, fontWeight: '700', fontSize: 13 }}>{titulo}</Text>
                    <Text style={{ color: c.muted, fontSize: 11 }}>{detalle}</Text>
                  </View>
                </View>
              );
            })
          )}
        </Card>

        {session ? <><Card>
          <Heading title="Enviar comando" />
          <Text style={{ color: c.muted, fontSize: 12, marginBottom: 10 }}>Nodo destino</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {nodos.length === 0 ? (
              <Text style={{ color: c.muted, fontSize: 13 }}>Sin nodos dados de alta todavía.</Text>
            ) : (
              nodos.map((n) => {
                const activo = nodoDestino === n.nodeCode;
                return (
                  <Pressable
                    key={n.id}
                    accessibilityRole="button"
                    onPress={() => setNodoDestino(n.nodeCode)}
                    style={{
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: activo ? c.accent : c.line,
                      backgroundColor: activo ? c.soft : c.card,
                    }}
                  >
                    <Text style={{ color: activo ? c.accent : c.ink, fontSize: 12, fontWeight: '700' }}>
                      {n.nodeCode} {n.isOnline ? '●' : '○'}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </View>

          {envioError && <Text style={{ color: c.accent, marginBottom: 10, fontSize: 13 }}>{envioError}</Text>}
          {ultimoComando && (
            <Text style={{ color: c.muted, fontSize: 12, marginBottom: 10 }}>
              {ACCION_LABEL[ultimoComando.action]} a {ultimoComando.targetNodeCode}:{' '}
              {avanceComando ? avanceComando.status : 'enviado, esperando confirmación…'}
              {avanceComando?.reason ? ` (${avanceComando.reason})` : ''}
            </Text>
          )}

          <View style={{ gap: 10 }}>
            {acciones.map((accion) => (
              <Action
                key={accion}
                title={enviando ? 'Enviando…' : ACCION_LABEL[accion]}
                onPress={() => emitir(accion)}
                disabled={enviando || !nodoDestino}
                secondary={accion === 'stop_alarm'}
              />
            ))}
          </View>
        </Card>

        <Action title="Cerrar sesión" onPress={salir} secondary /></> : <>
          <Card>
            <Heading title="Servidor de alertas" />
            <Field label="URL del backend" value={apiUrl} onChangeText={setApiUrl} placeholder="http://192.168.1.100:3000" />
            <Action title="Conectar alertas" onPress={() => setPublicUrl(apiUrl.trim())} />
          </Card>
          <Card>
            <Heading eyebrow="OPERADOR" title="Inicia sesión para enviar comandos" />
            <Field label="Correo" value={email} onChangeText={setEmail} placeholder="operador@sitciit.mx" keyboardType="email-address" />
            <Field label="Contraseña" value={password} onChangeText={setPassword} secureTextEntry />
            {loginError && <Text style={{ color: c.accent, marginBottom: 10, fontSize: 13 }}>{loginError}</Text>}
            <Action title={loggingIn ? 'Entrando…' : 'Iniciar sesión'} onPress={entrar} disabled={loggingIn || !email || !password} />
          </Card>
        </>}
        <Footer />
      </ScrollView>
    </SafeAreaView>
  );
}
