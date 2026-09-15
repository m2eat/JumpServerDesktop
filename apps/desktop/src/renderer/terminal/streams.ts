import { t } from '../i18n';

type Consumer = (data: Uint8Array) => void;
interface Stream { generation: number; bytes: number; pending: Uint8Array[]; consumer?: Consumer }
const streams = new Map<string, Stream>();
export function initializeTerminalStreams(): void {
  window.desktop.subscribe(event => {
    if (event.type === 'identity' && event.identity === null) { streams.clear(); return; }
    if (event.type === 'session' && ['closed', 'lost', 'failed'].includes(event.session.phase)) {
      const stream = streams.get(event.session.id);
      if (stream) { stream.consumer = undefined; streams.delete(event.session.id); }
      return;
    }
    if (event.type !== 'terminal') return;
    let stream = streams.get(event.sessionId);
    if (!stream || event.generation > stream.generation) {
      stream = { generation: event.generation, bytes: 0, pending: [] };
      streams.set(event.sessionId, stream);
    }
    if (event.generation !== stream.generation) return;
    if (stream.consumer) stream.consumer(event.data);
    else {
      stream.bytes += event.data.byteLength;
      if (stream.bytes > 4 * 1024 * 1024) {
        stream.pending = [new TextEncoder().encode(`\r\n[${t('输出消费停滞，已达到本地缓冲上限，连接将关闭；输出不再完整。')}]\r\n`)];
        stream.bytes = stream.pending[0].byteLength;
        void window.desktop.invoke('session.close', { sessionId: event.sessionId }).catch(error => {
          console.error(t('关闭过载终端失败'), error instanceof Error ? error.message : t('未知错误。'));
        });
      } else stream.pending.push(event.data);
    }
  });
}
export function attachTerminal(sessionId: string, generation: number, consumer: Consumer): () => void {
  let stream = streams.get(sessionId);
  if (!stream || stream.generation !== generation) { stream = { generation, bytes: 0, pending: [] }; streams.set(sessionId, stream); }
  stream.consumer = consumer;
  const pending = stream.pending;
  stream.pending = []; stream.bytes = 0;
  for (const data of pending) consumer(data);
  return () => { if (stream.consumer === consumer) stream.consumer = undefined; };
}
