/**
 * Мостик Piloot ↔ Telegram Web K.
 *
 * Единственное, что Piloot дописывает в Web K. Внутри ничего не меняет:
 * только отвечает на вопросы окна-хозяина и выполняет одну команду.
 *
 * Разговор идёт через postMessage и только с родительским окном. Открытый
 * сам по себе, Web K не заметит, что этот файл есть.
 */
import appImManager from '@lib/appImManager';
import rootScope from '@lib/rootScope';

/** Метка наших сообщений: чужие postMessage проходят мимо. */
const MARK = 'piloot';

/** Свой тип переноса. Держать в согласии с MESSAGE_MIME в Piloot. */
const MESSAGE_MIME = 'application/x-piloot-message';

/** Web K живёт сам по себе — мостик не нужен. */
const framed = window.parent !== window;

/**
 * Момент времени как «2026-09-04T12:40:17+03:00».
 * Тот же вид, что у Piloot: у сообщения важна минута, а без пояса
 * минута читается по-разному в разных местах.
 */
function isoWithZone(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const away = Math.abs(offset);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(away / 60))}:${pad(away % 60)}`
  );
}

/** Имя чата или человека одной строкой. */
async function titleOf(peerId: PeerId): Promise<string> {
  const peer: any = await rootScope.managers.appPeersManager.getPeer(peerId);
  if(!peer) return '';

  return peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(' ');
}

/** Сообщение в том виде, в каком его ждёт панель Piloot. */
async function messagePayload(peerId: PeerId, mid: number) {
  const message: any = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
  if(!message) return null;

  return {
    chatId: String(peerId),
    messageId: String(mid),
    text: message.message || '',
    from: {name: await titleOf(message.fromId ?? peerId), id: String(message.fromId ?? peerId)},
    date: isoWithZone(message.date),
    // Приметы вложения, а не сам файл: правило 3 Piloot.
    media: message.media ? {kind: message.media._} : undefined
  };
}

/**
 * Участники чата. Аватарку отдаём приметой (есть или нет), а не картинкой:
 * тащить байты через postMessage ради списка людей незачем.
 *
 * `getParticipants` сам разбирает, супергруппа это или обычный чат, — через
 * `getChatFull` список у супергрупп приходит пустым.
 */
async function membersOf(peerId: PeerId) {
  const result: any = await rootScope.managers.appProfileManager.getParticipants({
    id: peerId.toChatId()
  });
  const list: any[] = result?.participants ?? [];

  return {
    count: result?.count ?? list.length,
    people: await Promise.all(
      list.slice(0, 200).map(async(participant: any) => {
        const id = participant.user_id ?? participant.peer?.user_id ?? participant.userId;
        const peer: any = await rootScope.managers.appPeersManager.getPeer(id);

        return {
          id: String(id),
          name: peer ? peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(' ') : '',
          hasPhoto: Boolean(peer?.photo)
        };
      })
    )
  };
}

function reply(id: number, ok: unknown, error?: string) {
  window.parent.postMessage({[MARK]: 1, replyTo: id, ok, error}, '*');
}

async function handle(ask: any) {
  switch(ask.kind) {
    case 'chat': {
      const peerId = appImManager.chat?.peerId;
      return peerId ? {id: String(peerId), title: await titleOf(peerId)} : null;
    }

    case 'message':
      return messagePayload(ask.chatId.toPeerId(), Number(ask.messageId));

    case 'members':
      return membersOf(ask.chatId.toPeerId());

    case 'show': {
      // Единственная команда внутрь: открыть чат на сообщении.
      await appImManager.setInnerPeer({
        peerId: ask.chatId.toPeerId(),
        lastMsgId: Number(ask.messageId)
      });
      return true;
    }

    default:
      throw new Error('неизвестный вопрос: ' + ask.kind);
  }
}

function listen() {
  window.addEventListener('message', (event) => {
    if(event.source !== window.parent) return;

    const ask = event.data;
    if(!ask || ask[MARK] !== 1 || typeof ask.id !== 'number') return;

    handle(ask).then(
      (ok) => reply(ask.id, ok),
      (error) => reply(ask.id, null, String(error?.message ?? error))
    );
  });

  // Сменился чат — Piloot должен пойти за ним следом.
  appImManager.addEventListener('peer_changed', () => {
    const peerId = appImManager.chat?.peerId;
    if(!peerId) return;

    void titleOf(peerId).then((title) => {
      window.parent.postMessage({[MARK]: 1, event: 'chat', id: String(peerId), title}, '*');
    });
  });
}

/**
 * Пузырь становится перетаскиваемым и несёт нашу нагрузку.
 *
 * Атрибут ставим наблюдателем: пузыри рождаются и умирают по мере
 * прокрутки, и разово пройтись по разметке недостаточно.
 */
function makeDraggable() {
  /*
   * Нагрузку готовим заранее, здесь, а не в dragstart: собрать её —
   * это обещание, а dragstart обещаний не ждёт. Спохватись мы в момент
   * жеста — первый бросок ушёл бы пустым.
   */
  const mark = (root: ParentNode) => {
    root.querySelectorAll?.('.bubble[data-mid]:not([draggable])').forEach((bubble) => {
      const element = bubble as HTMLElement;
      element.setAttribute('draggable', 'true');

      const peerId = appImManager.chat?.peerId;
      const mid = Number(element.dataset.mid);
      if(!peerId || !mid) return;

      void messagePayload(peerId, mid).then((payload) => {
        if(payload) element.dataset.pilootPayload = JSON.stringify([payload]);
      });
    });
  };

  mark(document);
  new MutationObserver((records) => {
    for(const record of records) {
      record.addedNodes.forEach((node) => {
        if(node instanceof HTMLElement) mark(node);
      });
    }
  }).observe(document.body, {childList: true, subtree: true});

  document.addEventListener('dragstart', (event) => {
    const bubble = (event.target as HTMLElement)?.closest?.('.bubble[data-mid]');
    const peerId = appImManager.chat?.peerId;
    if(!bubble || !peerId || !event.dataTransfer) return;

    const ready = (bubble as HTMLElement).dataset.pilootPayload;
    if(ready) event.dataTransfer.setData(MESSAGE_MIME, ready);
  }, true);
}

if(framed) {
  listen();
  makeDraggable();
}
