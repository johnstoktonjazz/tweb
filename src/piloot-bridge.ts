/**
 * Мостик Piloot ↔ Telegram Web K.
 *
 * Единственное, что Piloot дописывает в Web K. Внутри ничего не меняет:
 * отвечает на вопросы окна-хозяина и выполняет его команды.
 *
 * Разговор идёт через postMessage и только с родительским окном. Открытый
 * сам по себе, Web K не заметит, что этот файл есть.
 *
 * Номера отдаём как есть, в виде Web K, но всегда с видом собеседника:
 * без него Piloot не сможет перевести их в свой формат — по одному числу
 * обычную группу от супергруппы не отличить.
 */
import appImManager from '@lib/appImManager';
import apiManagerProxy from '@lib/apiManagerProxy';
import rootScope from '@lib/rootScope';

/** Метка наших сообщений: чужие postMessage проходят мимо. */
const MARK = 'piloot';

/** Свой тип переноса. Держать в согласии с MESSAGE_MIME в Piloot. */
const MESSAGE_MIME = 'application/x-piloot-message';

/** Web K живёт сам по себе — мостик не нужен. */
const framed = window.parent !== window;

type ChatKind = 'user' | 'group' | 'channel';

/**
 * Кто по ту сторону. «Канал» здесь — и канал, и супергруппа: Web K их
 * не разделяет, и TDLib кодировал их одинаково. Piloot полагается на это.
 */
async function kindOf(peerId: PeerId): Promise<ChatKind> {
  /*
   * Менеджеры Web K живут в рабочем потоке, и обращение к ним — обещание,
   * даже когда метод выглядит мгновенным. Забыть про await здесь значило бы
   * получить непустое обещание, а оно истинно всегда: любой чат стал бы
   * человеком, и супергруппы переводились бы в неверный номер.
   */
  const peers = rootScope.managers.appPeersManager;
  if(await peers.isUser(peerId)) return 'user';

  return (await peers.isChannel(peerId)) ? 'channel' : 'group';
}

/** Имя чата или человека одной строкой. */
async function titleOf(peerId: PeerId): Promise<string> {
  const peer: any = await rootScope.managers.appPeersManager.getPeer(peerId);
  if(!peer) return '';

  return peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(' ');
}

async function chatOf(peerId: PeerId) {
  return {id: String(peerId), title: await titleOf(peerId), kind: await kindOf(peerId)};
}

/** Сообщение в том виде, в каком его ждёт панель Piloot. */
async function messagePayload(peerId: PeerId, mid: number) {
  const message: any = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
  if(!message) return null;

  const fromId = message.fromId ?? peerId;

  return {
    chatId: String(peerId),
    messageId: String(mid),
    kind: await kindOf(peerId),
    text: message.message || '',
    from: {name: await titleOf(fromId), id: String(fromId)},
    date: message.date,
    // Приметы вложения, а не сам файл: правило 3 Piloot.
    media: message.media ? {kind: message.media._} : undefined
  };
}

/**
 * Участники чата. Аватарку отдаём приметой «есть или нет»: сами картинки
 * Piloot спрашивает отдельно и только для тех лиц, что действительно показывает.
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

/**
 * Аватарка картинкой — по требованию и как самодостаточная строка.
 *
 * Именно строкой, а не ссылкой на объект: ссылка живёт в этой рамке и
 * умирает вместе с ней, а картинка нужна панели снаружи.
 */
async function photoOf(peerId: PeerId): Promise<string | null> {
  const photo: any = await rootScope.managers.appPeersManager.getPeerPhoto(peerId);
  if(!photo) return null;

  const url = await apiManagerProxy.loadAvatar(peerId, photo, 'photo_small');
  if(!url) return null;

  const blob = await (await fetch(url)).blob();

  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

function reply(id: number, ok: unknown, error?: string) {
  window.parent.postMessage({[MARK]: 1, replyTo: id, ok, error}, '*');
}

async function handle(ask: any) {
  switch(ask.kind) {
    case 'chat': {
      const peerId = appImManager.chat?.peerId;
      return peerId ? chatOf(peerId) : null;
    }

    case 'message':
      return messagePayload(ask.chatId.toPeerId(), Number(ask.messageId));

    case 'members':
      return membersOf(ask.chatId.toPeerId());

    case 'person':
      return chatOf(ask.id.toPeerId());

    case 'photo':
      return photoOf(ask.id.toPeerId());

    case 'show': {
      // Открыть чат на нужном сообщении.
      await appImManager.setInnerPeer({
        peerId: ask.chatId.toPeerId(),
        lastMsgId: Number(ask.messageId)
      });
      return true;
    }

    case 'openChat': {
      // Заменяет наш прежний экран профиля: разговор открывает Telegram.
      await appImManager.setPeer({peerId: ask.id.toPeerId()});
      return true;
    }

    case 'invoke':
      /*
       * Дверь ко всему Telegram API. Через неё пойдут расшифровка голосового,
       * ИИ-тон и напоминания — без новой правки Web K на каждый случай.
       */
      return rootScope.managers.apiManager.invokeApi(ask.method, ask.params ?? {});

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
      (error) => reply(ask.id, null, String(error?.type ?? error?.message ?? error))
    );
  });

  // Сменился чат — Piloot должен пойти за ним следом.
  appImManager.addEventListener('peer_changed', () => {
    const peerId = appImManager.chat?.peerId;
    if(!peerId) return;

    void chatOf(peerId).then((chat) => {
      window.parent.postMessage({[MARK]: 1, event: 'chat', ...chat}, '*');
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
    if(!bubble || !event.dataTransfer) return;

    /*
     * Пачку собираем из выделенного штатными средствами Web K. Выделения
     * нет — уходит один пузырь, тот, за который взялись.
     */
    const picked = [...document.querySelectorAll('.bubble.is-selected[data-piloot-payload]')];
    const source = picked.length > 1 ? picked : [bubble];

    const payloads = source
      .map((element) => (element as HTMLElement).dataset.pilootPayload)
      .filter(Boolean)
      .flatMap((raw) => JSON.parse(raw as string));

    if(payloads.length) event.dataTransfer.setData(MESSAGE_MIME, JSON.stringify(payloads));
  }, true);
}

if(framed) {
  listen();
  makeDraggable();
}
