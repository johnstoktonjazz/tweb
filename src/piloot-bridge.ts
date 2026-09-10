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
/*
 * Внутренности Web K берём ленивым импортом, а не обычным, — и это не вкус.
 *
 * Обычный импорт втягивал их в главный кусок сборки вместе с их стилями.
 * Правило виртуального списка чатов (`._Item{position:absolute}`) при этом
 * переезжало из своего куска в общий файл и оказывалось ВЫШЕ правила
 * `.row{position:relative}` — то перебивало его, строки списка занимали
 * место в потоке и одновременно сдвигались на свой `top`, и чаты
 * расходились вдвое.
 *
 * С ленивым импортом разбиение сборки возвращается к своему: проверено —
 * главный файл стилей выходит байт в байт как в сборке без нашего патча.
 *
 * Отсюда правило: **ничего из Web K не импортировать сверху этого файла.**
 */
type Внутренности = {
  appImManager: any;
  apiManagerProxy: any;
  themeController: any;
  appDownloadManager: any;
  choosePhotoSize: any;
  rootScope: any;
  appChatBackground: any;
  patternRenderer: any;
};

let взятое: Promise<Внутренности> | undefined;

function web(): Promise<Внутренности> {
  взятое ??= Promise.all([
    import('@lib/appImManager'),
    import('@lib/apiManagerProxy'),
    import('@lib/appDownloadManager'),
    import('@appManagers/utils/photos/choosePhotoSize'),
    import('@lib/rootScope'),
    import('@helpers/themeController'),
    import('@components/chat/bubbles/chatBackground'),
    import('@components/chat/patternRenderer')
  ]).then(([im, proxy, downloads, choose, scope, theme, background, pattern]) => ({
    appImManager: im.default,
    apiManagerProxy: proxy.default,
    appDownloadManager: downloads.default,
    choosePhotoSize: choose.default,
    rootScope: scope.default,
    themeController: theme.default,
    appChatBackground: background.default,
    patternRenderer: pattern.default
  }));

  return взятое;
}

/*
 * Номер собеседника всегда зовётся `peerId`, а не `id`: `id` занят номером
 * самого вопроса. Пока эти два поля назывались одинаково, номер собеседника
 * затирал номер вопроса — и вопросы про человека, лицо и открытие чата
 * молча пропадали, не дойдя до разбора.
 */

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
  const {rootScope} = await web();
  const peers = rootScope.managers.appPeersManager;
  if(await peers.isUser(peerId)) return 'user';

  return (await peers.isChannel(peerId)) ? 'channel' : 'group';
}

/** Имя чата или человека одной строкой. */
async function titleOf(peerId: PeerId): Promise<string> {
  const {rootScope} = await web();
  const peer: any = await rootScope.managers.appPeersManager.getPeer(peerId);
  if(!peer) return '';

  return peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(' ');
}

async function chatOf(peerId: PeerId) {
  return {id: String(peerId), title: await titleOf(peerId), kind: await kindOf(peerId)};
}

/**
 * Как вид вложения называется у Web K и как — у Piloot.
 *
 * Перевод нужен потому, что Piloot складывает вид вложения в файл проекта:
 * там должны лежать наши слова, а не внутренние имена чужой библиотеки.
 * Чего в списке нет — «документ»: показывать его всё равно нечем, кроме
 * имени файла.
 */
const MEDIA_KINDS: Record<string, string> = {
  voice: 'voice',
  audio: 'audio',
  round: 'video-note',
  video: 'video',
  sticker: 'sticker',
  photo: 'photo',
  gif: 'animation'
};

/** Приметы вложения: вид, имя, размер, длительность. Файла здесь нет. */
function mediaOf(media: any) {
  if(!media) return undefined;

  if(media._ === 'messageMediaPhoto') return {kind: 'photo'};

  const document = media.document;
  if(!document) return undefined;

  const приметы: any = {kind: MEDIA_KINDS[document.type] ?? 'document'};

  if(document.file_name) приметы.name = document.file_name;
  if(typeof document.size === 'number') приметы.size = document.size;
  if(typeof document.duration === 'number') приметы.duration = document.duration;

  return приметы;
}

/** Само вложение сообщения: фотография или документ. */
async function fileOf(peerId: PeerId, mid: number) {
  const {rootScope} = await web();
  const message: any = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);

  return message?.media?.photo ?? message?.media?.document ?? null;
}

/** Сообщение в том виде, в каком его ждёт панель Piloot. */
async function messagePayload(peerId: PeerId, mid: number) {
  const {rootScope} = await web();
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
    media: mediaOf(message.media)
  };
}

/**
 * Участники чата. Аватарку отдаём приметой «есть или нет»: сами картинки
 * Piloot спрашивает отдельно и только для тех лиц, что действительно показывает.
 */
async function membersOf(peerId: PeerId) {
  const {rootScope} = await web();
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
  const {rootScope, apiManagerProxy} = await web();
  const photo: any = await rootScope.managers.appPeersManager.getPeerPhoto(peerId);
  if(!photo) return null;

  const url = await apiManagerProxy.loadAvatar(peerId, photo, 'photo_small');
  if(!url) return null;

  return asDataUrl(url);
}

/**
 * Ссылка на файл → строка `data:`.
 *
 * Ссылка живёт в этой рамке и умирает вместе с ней, а картинку и звук
 * панель показывает у себя — значит наружу должно уйти самодостаточное.
 */
async function asDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();

  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** Превью вложения под ширину, которую просит панель. Нечего показать — пусто. */
async function thumbOf(peerId: PeerId, mid: number, width: number): Promise<string | null> {
  const media: any = await fileOf(peerId, mid);
  if(!media) return null;

  const {choosePhotoSize, appDownloadManager} = await web();
  const size = choosePhotoSize(media, width, width, true);
  const url = await appDownloadManager.downloadMediaURL({media, thumb: size as any});

  return url ? asDataUrl(url) : null;
}

/**
 * Голосовое целиком: играет его панель, а не Web K.
 *
 * Целиком, а не потоком: голосовое короткое, а плеер панели умеет только
 * готовый файл — и это ровно то, что у неё было с TDLib.
 */
async function voiceOf(peerId: PeerId, mid: number): Promise<string | null> {
  const media: any = await fileOf(peerId, mid);
  if(!media) return null;

  const {appDownloadManager} = await web();
  const url = await appDownloadManager.downloadMediaURL({media});

  return url ? asDataUrl(url) : null;
}

/*
 * ── Обои ──────────────────────────────────────────────────────────────
 *
 * Раньше мы отдавали Piloot «рецепт» — цвета, узор, силу — и он рисовал по
 * нему свои обои. Рецепт расходился с настоящими: градиент Telegram считает
 * своей формулой на холсте 50×50 и растягивает, а не кладёт пятна по углам;
 * плитка узора у него считается от высоты окна, а не берётся из файла.
 * На стыке рамки и панели это давало шов.
 *
 * Поэтому теперь мы не пересказываем его фон, а **показываем его же**:
 *  · градиент Piloot получает живым зеркалом (см. `зеркалоГрадиента`);
 *  · всё остальное снимаем с его собственных слоёв — коробки, прозрачности,
 *    способ наложения. Ни одного числа отсюда мы не придумываем.
 */

/** Коробка элемента: где стоит и какого размера, в точках окна Telegram. */
function коробка(el: Element) {
  const {left, top, width, height} = el.getBoundingClientRect();

  return {left, top, width, height};
}

/**
 * Видимый слой фона.
 *
 * Слоёв у него всегда два: один на экране, второй собирается про запас и
 * ждёт своей очереди. Различаются прозрачностью — берём тот, что виден.
 */
function живойСлой(корень: HTMLElement): HTMLElement | null {
  let лучший: HTMLElement | null = null;
  let сила = 0;

  for(const холст of Array.from(корень.querySelectorAll('canvas, img'))) {
    const слой = холст.parentElement;
    if(!слой) continue;

    const своя = Number(getComputedStyle(слой).opacity);
    if(своя > сила) {
      сила = своя;
      лучший = слой;
    }
  }

  return сила > 0.5 ? лучший : null;
}

/**
 * Настройки узора у самого Web K.
 *
 * Адрес картинки узора он держит только внутри своего рисовальщика — ни в
 * разметке, ни в стилях его нет. Находим рисовальщика по холсту, который он
 * заполнил: холст мы уже держим в руках, и совпадение получается точным.
 */
function узорХолста(patternRenderer: any, холст: HTMLCanvasElement): any {
  const все = patternRenderer?.INSTANCES;
  if(!Array.isArray(все)) return null;

  return все.find((один: any) => один?.canvases?.has?.(холст))?.options ?? null;
}

/**
 * Обои переписки: как Telegram нарисовал фон прямо сейчас.
 *
 * Отдаём не рецепт, а снятые с его слоёв числа. Градиент здесь только
 * коробкой и прозрачностью — сама картинка приходит зеркалом, отдельно.
 */
async function wallpaperOf() {
  const {appChatBackground, patternRenderer} = await web();
  const корень: HTMLElement | undefined = appChatBackground?.element;
  if(!корень) return null;

  const слой = живойСлой(корень);
  if(!слой) return null;

  let градиент: any = null;
  let узор: any = null;
  let картинка: any = null;

  for(const дитя of Array.from(слой.children)) {
    const вид = getComputedStyle(дитя);
    const прозрачность = Number(вид.opacity);

    if(дитя instanceof HTMLCanvasElement) {
      /*
       * Два холста, и различить их проще всего по размеру: градиент он
       * считает на крошечном (50×50) и растягивает, узор рисует во всё окно.
       */
      if(дитя.width <= 200) {
        градиент = {...коробка(дитя), opacity: прозрачность};
        continue;
      }

      const свои = узорХолста(patternRenderer, дитя);
      if(!свои?.url) continue;

      узор = {
        ...коробка(дитя),
        url: свои.url,
        opacity: прозрачность,
        blend: вид.mixBlendMode,
        invert: вид.filter !== 'none',
        /*
         * Тёмный узор он рисует наоборот: холст заливается чёрным, а сам
         * рисунок вырезается из него дырками. Дальше цвет виден только
         * сквозь дырки.
         */
        mask: !!свои.mask,
        /*
         * Высота плитки. Единственное число Web K, которое мы повторяем, а
         * не снимаем: переменной для него нет, оно живёт формулой в
         * webk/src/components/chat/patternRenderer.ts, в `fillCanvas`.
         */
        tileHeight: 500 + window.innerHeight / 2.5
      };

      continue;
    }

    if(дитя instanceof HTMLImageElement) {
      картинка = {...коробка(дитя), url: дитя.src, opacity: прозрачность};
    }
  }

  return {
    gradient: градиент,
    pattern: узор,
    picture: картинка,
    /* Фон под слоями: у тёмных обоев он чёрный и виден между рисунком. */
    background: getComputedStyle(слой).backgroundColor
  };
}

/**
 * Живое зеркало градиента.
 *
 * У Web K это штатная возможность: он сам ею красит полосу папок слева.
 * Даёшь ему свой холст — и он перерисовывает его каждый раз, когда
 * перерисовывает свой. Значит, у Piloot не копия градиента, а он сам.
 *
 * Холсты приходят из окна Piloot — оно того же происхождения, и рисовать в
 * них Web K может напрямую. Сменил тему или обои — заводится новый
 * рисовальщик, и зеркало перецепляется само.
 */
function зеркалоГрадиента(холсты: HTMLCanvasElement[]): Promise<() => void> {
  return web().then(({appChatBackground}) => {
    let отцепить: (() => void)[] = [];

    const перецепить = (рисовальщик: any) => {
      for(const снять of отцепить) снять();
      отцепить = [];

      if(!рисовальщик) return;
      for(const холст of холсты) отцепить.push(рисовальщик.attachMirror(холст));
    };

    const отписка = appChatBackground.onActiveGradientRendererChange(перецепить);

    return () => {
      отписка();
      перецепить(null);
    };
  });
}

function reply(id: number, ok: unknown, error?: string) {
  window.parent.postMessage({[MARK]: 1, replyTo: id, ok, error}, '*');
}

async function handle(ask: any) {
  const {appImManager, rootScope} = await web();

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
      return chatOf(ask.peerId.toPeerId());

    case 'photo':
      return photoOf(ask.peerId.toPeerId());

    case 'thumb':
      return thumbOf(ask.chatId.toPeerId(), Number(ask.messageId), Number(ask.width));

    case 'voice':
      return voiceOf(ask.chatId.toPeerId(), Number(ask.messageId));

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
      await appImManager.setPeer({peerId: ask.peerId.toPeerId()});
      return true;
    }

    case 'wallpaper':
      return wallpaperOf();

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

  /*
   * Сменилась тема или обои — Piloot перекрашивается следом. Шлём сами, не
   * дожидаясь вопроса: перерисовать фон надо в тот же миг, а не при
   * следующем обращении.
   */
  void web().then(({rootScope}) => {
    const рассказать = () => {
      void wallpaperOf().then((wallpaper) => {
        window.parent.postMessage({[MARK]: 1, event: 'wallpaper', wallpaper}, '*');
      });
    };

    rootScope.addEventListener('theme_changed', рассказать);
    rootScope.addEventListener('background_changed', рассказать);
  });

  // Сменился чат — Piloot должен пойти за ним следом.
  void web().then(({appImManager}) => {
    appImManager.addEventListener('peer_changed', () => {
      const peerId = appImManager.chat?.peerId;
      if(!peerId) return;

      void chatOf(peerId).then((chat) => {
        window.parent.postMessage({[MARK]: 1, event: 'chat', ...chat}, '*');
      });
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
   * Пока внутренности не приехали, номер открытого чата спросить не у кого.
   * Держим их здесь: наблюдатель зовёт `mark` часто, и ждать в нём нельзя.
   */
  let чат: any;
  void web().then((всё) => (чат = всё.appImManager));

  /*
   * Нагрузку готовим заранее, здесь, а не в dragstart: собрать её —
   * это обещание, а dragstart обещаний не ждёт. Спохватись мы в момент
   * жеста — первый бросок ушёл бы пустым.
   */
  const mark = (root: ParentNode) => {
    root.querySelectorAll?.('.bubble[data-mid]').forEach((bubble) => {
      const element = bubble as HTMLElement;
      const peerId = чат?.chat?.peerId;
      const mid = element.dataset.mid;
      if(!peerId || !mid) return;

      /*
       * Уже собрана и на тот же номер — второй раз не собираем. Сравнение
       * именно с номером, а не «есть ли нагрузка»: Web K выдаёт
       * отправляемому сообщению временный номер (822363.0001) и заменяет
       * его настоящим, когда сервер ответит. Собранная однажды нагрузка
       * после этого указывает в никуда, а её округление — на соседнее
       * сообщение. Так тикет однажды и сослался на чужой текст.
       */
      const готовая = element.dataset.pilootPayload;
      if(готовая && готовая.indexOf('"messageId":"' + mid + '"') !== -1) return;

      element.setAttribute('draggable', 'true');

      void messagePayload(peerId, Number(mid)).then((payload) => {
        // Пока нагрузка собиралась, номер мог смениться снова.
        if(payload && element.dataset.mid === mid) {
          element.dataset.pilootPayload = JSON.stringify([payload]);
        }
      });
    });
  };

  mark(document);
  new MutationObserver((records) => {
    for(const record of records) {
      if(record.type === 'attributes') {
        if(record.target instanceof HTMLElement) mark(record.target.parentNode ?? document);
        continue;
      }

      record.addedNodes.forEach((node) => {
        if(node instanceof HTMLElement) mark(node);
      });
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    // Номер сообщения меняется прямо на месте, без пересоздания пузыря.
    attributes: true,
    attributeFilter: ['data-mid']
  });

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

    if(!payloads.length) return;

    event.dataTransfer.setData(MESSAGE_MIME, JSON.stringify(payloads));
    event.dataTransfer.effectAllowed = 'copy';

    /*
     * Сколько сообщений едет — отдельным сообщением наружу: пока жест идёт,
     * саму нагрузку браузер читать не даёт, а подпись на затемнении обязана
     * назвать число до броска.
     */
    window.parent.postMessage({[MARK]: 1, event: 'drag', count: payloads.length}, '*');
  }, true);

  document.addEventListener('dragend', () => {
    window.parent.postMessage({[MARK]: 1, event: 'drag', count: 0}, '*');
  }, true);
}

if(framed) {
  /*
   * Зеркало передаём не сообщением, а прямым вызовом: холст через
   * postMessage не проходит, а окна у нас одного происхождения — Piloot
   * достаёт до этой функции так же, как он уже читает наши переменные темы.
   */
  (window as any).pilootBackground = {mirror: зеркалоГрадиента};

  listen();
  makeDraggable();
}
