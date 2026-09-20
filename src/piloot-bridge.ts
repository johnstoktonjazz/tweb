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
  ChatContextMenu: any;
  SetTransition: any;
  fastRaf: any;
  getVisibleRect: any;
  cancelContextMenuOpening: any;
  placeCaretAtEnd: any;
  isInputEmpty: any;
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
    import('@components/chat/patternRenderer'),
    import('@components/chat/contextMenu'),
    import('@components/singleTransition'),
    import('@helpers/schedulers'),
    import('@helpers/dom/getVisibleRect'),
    import('@helpers/dom/attachContextMenuListener'),
    import('@helpers/dom/placeCaretAtEnd'),
    import('@helpers/dom/isInputEmpty')
  ]).then(([im, proxy, downloads, choose, scope, theme, background, pattern, menu, transition, schedulers, visible, contextMenu, caret, empty]) => ({
    appImManager: im.default,
    apiManagerProxy: proxy.default,
    appDownloadManager: downloads.default,
    choosePhotoSize: choose.default,
    rootScope: scope.default,
    themeController: theme.default,
    appChatBackground: background.default,
    patternRenderer: pattern.default,
    ChatContextMenu: menu.default,
    SetTransition: transition.default,
    fastRaf: schedulers.fastRaf,
    getVisibleRect: visible.default,
    cancelContextMenuOpening: contextMenu.cancelContextMenuOpening,
    placeCaretAtEnd: caret.default,
    isInputEmpty: empty.default
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

/*
 * Вошёл ли человек в Telegram (Piloot, задача 156).
 *
 * Пока не вошёл, мостик внутренностей Web K не трогает вовсе. Взять их у
 * невошедшего значило запустить части Telegram, рассчитанные на
 * вошедшего: они шлют запрос с незарегистрированным ключом, сервер
 * отвечает AUTH_KEY_UNREGISTERED, Web K перезагружает себя — и так по
 * кругу, раз в 3,5–5 с (замер 156). Войти было нельзя.
 *
 * О входе узнаём по вести самого Web K — `user_auth` на его `rootScope`.
 * Этот узел Web K грузит сам ещё до экрана входа (`src/index.ts` берёт
 * его сверху), поэтому, взяв его, мостик ничего нового не запускает.
 * Вошедшему весть приходит при чтении состояния; чтобы не пропустить её,
 * смотрим ещё и уже известный номер `myId`.
 *
 * После входа по QR страница не перезагружается — чаты появляются тут же.
 * Поэтому вход замечаем на ходу, а не только при загрузке.
 */
let вошёл = false;

const входПроизошёл: Promise<void> = new Promise((готово) => {
  if(!framed) return;

  void import('@lib/rootScope').then(({default: rootScope}) => {
    const отметить = (): void => {
      if(вошёл) return;

      вошёл = true;
      готово();
      посмотретьВид();
    };

    rootScope.addEventListener('user_auth', отметить);
    if(rootScope.myId) отметить();
  });
});

/*
 * Что слева на экране — форма входа или чаты (156). Панель проектов у
 * невошедшего не показывается вовсе и появляется ровно тогда, когда
 * слева появились чаты: не раньше, иначе форма входа сузилась бы на
 * глазах, пока её ещё видно.
 *
 * Чаты на экране — когда Web K снял с `body` класс `has-auth-pages`
 * (`bootstrapIm`) и человек вошёл. Форма входа — когда Web K вставил в
 * `body` корень `#auth-flow-root` (`mountAuthFlow`). И класс, и узел ставит
 * сам Web K; мостик только смотрит.
 */
type ВидСлева = 'вход' | 'чаты' | null;

let видСлева: ВидСлева = null;

function посмотретьВид(): void {
  const чаты = вошёл && !document.body.classList.contains('has-auth-pages');
  const вход = !чаты && document.getElementById('auth-flow-root') !== null;
  const стало: ВидСлева = чаты ? 'чаты' : вход ? 'вход' : null;

  if(стало === null || стало === видСлева) return;

  видСлева = стало;
  window.parent.postMessage({[MARK]: 1, event: 'auth', signedIn: стало === 'чаты'}, '*');
}

function следитьЗаВидом(): void {
  new MutationObserver(посмотретьВид).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true
  });

  посмотретьВид();
}

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

/**
 * Чат для панели: номер, название, вид. У человека ещё имя — как Telegram
 * его показывает — и признак бота (Piloot 160): по ним панель подписывает
 * пилюлю собеседника и не заводит её боту. Всё из той же памяти Web K,
 * что и название, — лишнего похода в Telegram нет.
 */
async function chatOf(peerId: PeerId) {
  const kind = await kindOf(peerId);
  const чат: {id: string, title: string, kind: ChatKind, firstName?: string, bot?: boolean, username?: string} = {
    id: String(peerId),
    title: await titleOf(peerId),
    kind
  };

  if(kind === 'user') {
    const {rootScope} = await web();
    const человек: any = await rootScope.managers.appPeersManager.getPeer(peerId);

    чат.firstName = человек?.first_name ?? '';
    if(человек?.pFlags?.bot) чат.bot = true;
    /* Username — для упоминания в тексте тикета (Piloot 167). */
    const ник = человек?.username ?? человек?.usernames?.find((one: any) => one?.pFlags?.active)?.username;
    if(ник) чат.username = ник;
  }

  return чат;
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

/*
 * Реакции сообщений одного чата (Piloot 166) — только чтение.
 *
 * Сообщения берём прямым запросом по номерам, тем же, каким Web K
 * догружает одиночные сообщения: чат не открывается, в память Web K ничего
 * не ложится, прочитанным ничего не отмечается. Кто поставил — из
 * короткого списка внутри сообщения; если реакций на нём больше, чем в
 * коротком, — из полного списка.
 *
 * `listed` — видно ли, кто поставил. В личном чате видно всегда, хотя
 * Telegram и снимает там флаг (живая разведка 166); у групп и каналов —
 * по флагу. Сообщения нет — `gone`.
 */
const СООБЩЕНИЙ_ЗА_РАЗ = 100;
const СТРАНИЦ_СПИСКА = 5;

async function reactionsOf(peerId: PeerId, ids: number[]) {
  const {rootScope} = await web();
  const m = rootScope.managers;
  const личный = await m.appPeersManager.isUser(peerId);
  const канал = !личный && await m.appPeersManager.isChannel(peerId);
  const номера = ids.slice(0, СООБЩЕНИЙ_ЗА_РАЗ).map((id) => ({_: 'inputMessageID', id}));
  const ответ: any = канал ?
    await m.apiManager.invokeApi('channels.getMessages', {
      channel: await m.appChatsManager.getChannelInput(peerId.toChatId()),
      id: номера
    } as any) :
    await m.apiManager.invokeApi('messages.getMessages', {id: номера} as any);
  const пришли = new Map<number, any>();
  for(const message of ответ?.messages ?? []) {
    if(message?._ === 'message') пришли.set(message.id, message);
  }

  const вход = await m.appPeersManager.getInputPeerById(peerId);
  const итог = [];

  for(const id of ids.slice(0, СООБЩЕНИЙ_ЗА_РАЗ)) {
    const message = пришли.get(id);
    if(!message) {
      итог.push({id, gone: true, listed: true, reactions: [] as any[]});
      continue;
    }

    const изПамяти = реакцииИзПамяти(message, личный);
    if(изПамяти) {
      итог.push({id, ...изПамяти});
      continue;
    }

    const список: any[] = [];
    let offset: string | undefined;
    for(let страница = 0; страница < СТРАНИЦ_СПИСКА; ++страница) {
      const часть: any = await m.apiManager.invokeApi('messages.getMessageReactionsList', {
        peer: вход,
        id,
        limit: 100,
        ...(offset ? {offset} : {})
      } as any);
      список.push(...(часть?.reactions ?? []).filter((one: any) => one?.reaction?._ === 'reactionEmoji'));
      offset = часть?.next_offset;
      if(!offset) break;
    }

    итог.push({
      id,
      listed: true,
      reactions: список
      .filter((one: any) => one?.peer_id?._ === 'peerUser')
      .map((one: any) => ({userId: String(one.peer_id.user_id), emoji: String(one.reaction.emoticon), date: Number(one.date) || 0}))
    });
  }

  return итог;
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
  /* До входа внутренностей не трогаем (156): отцеплять нечего. */
  if(!вошёл) return Promise.resolve((): void => {});

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

    case 'reactions':
      return reactionsOf(String(ask.chatId).toPeerId(), (ask.ids ?? []).map(Number).filter(Number.isInteger));

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

    case 'closeChat': {
      /*
       * Закрыть чат — «все проекты» справа. Зовём ровно то же, что зовёт
       * сам Web K, когда снимает чат со стопки навигации по Esc или по
       * стрелке назад в узком окне (appImManager.ts, onPop у пункта 'im').
       */
      await appImManager.setPeer({});
      return true;
    }

    case 'wallpaper':
      return wallpaperOf();

    case 'insertText':
      return вставитьТекст(String(ask.text ?? ''));

    case 'canWrite':
      return можноПисать();

    case 'startNeeded': {
      /*
       * Нужна ли в открытом чате бота кнопка «Старт» (Piloot 174): человек
       * этого бота ещё не запускал. Сами мы её не нажимаем никогда.
       */
      const chat = appImManager.chat;
      if(!chat || String(chat.peerId) !== String(ask.chatId)) return false;
      return chat.isStartButtonNeeded();
    }

    case 'watchBot':
      /* Слушать сообщения одного чата бота (Piloot 174); null — перестать. */
      слушаемБота = ask.chatId ? String(ask.chatId) : null;
      return true;

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

    /* Что слева на экране — отвечаем всегда, внутренности тут не нужны. */
    if(ask.kind === 'auth') {
      reply(ask.id, видСлева === null ? null : видСлева === 'чаты');
      return;
    }

    /*
     * Спросили до входа — «не вошли», ничего не запуская (156). Любой
     * ответ по существу потянул бы внутренности Web K, а с ними и цикл
     * перезагрузок.
     */
    if(!вошёл) {
      reply(ask.id, null, 'не вошли');
      return;
    }

    handle(ask).then(
      (ok) => reply(ask.id, ok),
      (error) => reply(ask.id, null, String(error?.type ?? error?.message ?? error))
    );
  });
}

/*
 * Тема и смена чата — только после входа (156): оба слушателя живут на
 * внутренностях Web K.
 */
function следитьЗаТемойИЧатом() {
  /*
   * Сменилась тема или обои — Piloot перекрашивается следом. Шлём сами, не
   * дожидаясь вопроса: перерисовать фон надо в тот же миг, а не при
   * следующем обращении.
   *
   * И один раз сразу после входа: до входа панель спрашивала вид и
   * получала «не вошли», а перекраситься ей нужно уже сейчас.
   */
  void web().then(({rootScope}) => {
    const рассказать = () => {
      void wallpaperOf().then((wallpaper) => {
        window.parent.postMessage({[MARK]: 1, event: 'wallpaper', wallpaper}, '*');
      });
    };

    rootScope.addEventListener('theme_changed', рассказать);
    rootScope.addEventListener('background_changed', рассказать);
    рассказать();
  });

  /*
   * Сменился чат — Piloot должен пойти за ним следом.
   *
   * И закрылся тоже: раньше про закрытие мы молчали, и панель никогда не
   * узнавала, что слева стало пусто. А пусто слева — это «все проекты»
   * справа, и без этой вести до них не добраться.
   */
  void web().then(({appImManager}) => {
    appImManager.addEventListener('peer_changed', () => {
      const peerId = appImManager.chat?.peerId;

      if(!peerId) {
        window.parent.postMessage({[MARK]: 1, event: 'chat', chatId: null}, '*');
        return;
      }

      void chatOf(peerId).then((chat) => {
        window.parent.postMessage({[MARK]: 1, event: 'chat', ...chat}, '*');
      });
    });
  });

  /*
   * Человек ткнул в строку чата (Piloot 180.1).
   *
   * «Сменился чат» Web K шлёт только при настоящей смене собеседника:
   * выбрал уже открытый чат — события нет. А это единственное
   * очевидное движение человека, когда переписка и панель разошлись
   * (после перехода к сообщению-источнику панель остаётся на своём
   * проекте). Поэтому слушаем сам выбор.
   *
   * Слушаем на документе, а не на конкретном списке: строка чата
   * встречается и в списке, и в архиве, и в поиске — правило должно
   * быть одно на все места (решение владельца при 180.1).
   *
   * Берём только строки списка (`li` с приметой). Саму примету носят
   * ещё аватарки в сообщениях и фотографии: нажатие по ним чат не
   * меняет, и панель от них дёргаться не должна.
   *
   * Только простое нажатие левой кнопкой: правая открывает их
   * контекстное меню и чат не меняет.
   *
   * В разметку Web K ничего не вставляем и ничего в ней не правим —
   * только слушаем и читаем его же примету `data-peer-id`, которой он
   * пользуется сам (правило 12).
   */
  document.addEventListener('click', (event) => {
    if(event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

    const цель = event.target as HTMLElement | null;
    const строка = цель?.closest?.('li[data-peer-id]') as HTMLElement | null;
    const номер = строка?.dataset?.peerId;

    if(!номер) return;

    void chatOf(Number(номер).toPeerId()).then((chat) => {
      window.parent.postMessage({[MARK]: 1, event: 'chat-picked', ...chat}, '*');
    });
  }, {capture: true});
}

/** Пузырь, которому принадлежит узел: текст внутри пузыря — тоже его. */
function пузырьОт(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
  return (element?.closest?.('.bubble[data-mid]') as HTMLElement | null) ?? null;
}

/**
 * Выделенный текст в переписке и пузыри, которые он задевает.
 *
 * Пусто, если выделения нет или оно лежит вне пузырей — например, в
 * поле ввода.
 */
function выделенное(): {bubbles: HTMLElement[], text: string} | null {
  const selection = window.getSelection();
  if(!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  const bubbles = ([...document.querySelectorAll('.bubble[data-mid]')] as HTMLElement[])
    .filter((bubble) => range.intersectsNode(bubble));
  const text = selection.toString().trim();

  return bubbles.length && text ? {bubbles, text} : null;
}

/** Готовые нагрузки пузырей: собраны заранее, в `mark`. */
function нагрузкиИз(bubbles: HTMLElement[]): any[] {
  return bubbles
  .map((element) => element.dataset.pilootPayload)
  .filter(Boolean)
  .flatMap((raw) => JSON.parse(raw as string));
}

/**
 * Пункт «Send to Piloot» в меню сообщения (153; до 164 — «Сделать тикет»).
 *
 * Файлы Web K мы не правим, поэтому пункт добавляет мостик: подменяет у
 * меню метод, который отбирает пункты перед показом, и дописывает свой.
 * Цена известна и принята владельцем: переименуй Web K этот метод при
 * обновлении — пункт пропадёт. Web K обновляем руками по номеру коммита,
 * поэтому узнаем сразу; мостик скажет об этом в консоль.
 */
function addTicketItem() {
  void web().then(({ChatContextMenu}) => {
    const прототип = ChatContextMenu?.prototype;
    const отбор = прототип?.filterButtons;

    if(typeof отбор !== 'function') {
      console.warn('[piloot] меню сообщения устроено иначе — пункт «Сделать тикет» не добавлен');
      return;
    }

    прототип.filterButtons = function(this: any, buttons: any[]): Promise<any[]> {
      if(!buttons.some((button) => button?.pilootTicket)) {
        const слова = (window.parent as any).pilootForWebk?.words;
        const пункт = {
          pilootTicket: true,
          icon: 'plusround',
          regularText: слова?.makeTicket ?? 'Send to Piloot',
          withSelection: true,
          onClick: (): void => {
            void сделатьТикет(this);
          },
          verify: (): boolean => this.message?._ === 'message' && !this.isSponsored
        };
        // Рядом с «Копировать»: то же семейство — взять сообщение с собой.
        const место = buttons.findIndex((button) => button?.text === 'Copy');
        buttons.splice(место === -1 ? 0 : место, 0, пункт);
      }

      return отбор.call(this, buttons);
    };
  });
}

/**
 * Что уходит в тикет из меню.
 *
 * Выбраны сообщения штатным выделением Web K — они все, по порядку.
 * Выделен текст в одном сообщении — это сообщение с куском. Текст задевает
 * несколько — они целиком. Иначе — то сообщение, по которому открыли меню.
 */
async function сделатьТикет(menu: any) {
  const peerId = menu.messagePeerId ?? menu.peerId;
  const выбранные: number[] = menu.chat?.selection?.isSelecting ?
    [...(menu.chat.selection.selectedMids?.get?.(peerId) ?? [])] :
    [];

  let payloads: any[];

  if(выбранные.length) {
    payloads = await Promise.all(выбранные.sort((a, b) => a - b).map((mid) => messagePayload(peerId, mid)));
  } else {
    const выбор = menu.isTextSelected ? выделенное() : null;
    const пузыри = выбор?.bubbles ?? [];

    if(пузыри.length > 1) {
      payloads = await Promise.all(пузыри.map((bubble) => messagePayload(bubble.dataset.peerId?.toPeerId?.() ?? peerId, Number(bubble.dataset.mid))));
    } else if(пузыри.length === 1) {
      const payload = await messagePayload(пузыри[0].dataset.peerId?.toPeerId?.() ?? peerId, Number(пузыри[0].dataset.mid));
      payloads = [payload && {...payload, quote: выбор.text}];
    } else {
      payloads = [await messagePayload(peerId, menu.mid)];
    }
  }

  payloads = payloads.filter(Boolean);
  if(payloads.length) window.parent.postMessage({[MARK]: 1, event: 'ticket', payloads}, '*');
}

/**
 * Бросок — только после задержки (153).
 *
 * Перетаскивание и выделение висят на одном движении, поэтому пузырь можно
 * тащить, только подержав указатель на месте. Двинул раньше — Chromium зовёт
 * dragstart, мы его отменяем, и дальше идёт обычное выделение текста.
 * Подержал — пузырь «взят»: получает отметку, слой стилей Piloot его
 * приподнимает, и dragstart пропускаем.
 *
 * Порог дрожи — самого Chromium (вариант «а» владельца): отменённый
 * dragstart хоронит перетаскивание до отпускания кнопки, и погасить мелкое
 * движение раньше него нельзя — замерено в 153. Задержку и правило даёт
 * панель (`src/shared/hold.ts` Piloot): там их проверки и там их подбирают.
 */
type Нажатие = {bubble: HTMLElement, t0: number, x0: number, y0: number, сдвиг: number, итог: string, таймер: number};

let нажатие: Нажатие | null = null;

/** Правило задержки от панели. Нет его — Web K открыт не в Piloot, ворот нет. */
function правилоЗадержки(): any {
  return (window.parent as any).pilootForWebk?.hold;
}

/** Нажатие кончилось: отметку «взят» снимаем, ожидание гасим. */
function отпустить() {
  if(!нажатие) return;

  clearTimeout(нажатие.таймер);
  нажатие.bubble.removeAttribute('data-piloot-lifted');
  нажатие = null;
}

/** Нажали ли внутри уже выделенного текста: тогда это вторая дверь. */
function внутриВыделения(x: number, y: number): boolean {
  if(!выделенное()) return false;

  const каретка = document.caretRangeFromPoint?.(x, y);
  return !!каретка && window.getSelection().getRangeAt(0).isPointInRange(каретка.startContainer, каретка.startOffset);
}

function holdToThrow() {
  document.addEventListener('pointerdown', (event) => {
    отпустить();
    if(event.button !== 0 || event.pointerType === 'touch') return;

    const bubble = пузырьОт(event.target as Node);
    const правило = правилоЗадержки();
    if(!bubble || !правило) return;

    // Внутри выделения браузер тащит выделенное сам — задержка не нужна.
    if(внутриВыделения(event.clientX, event.clientY)) return;

    const своё: Нажатие = {bubble, t0: performance.now(), x0: event.clientX, y0: event.clientY, сдвиг: 0, итог: 'wait', таймер: 0};

    своё.таймер = window.setTimeout(() => {
      if(нажатие !== своё || своё.итог !== 'wait') return;

      своё.итог = правило.verdict(performance.now() - своё.t0, своё.сдвиг);
      if(своё.итог !== 'lift') return;

      своё.bubble.setAttribute('data-piloot-lifted', '');
      /*
       * За время удержания Chromium успевает начать выделение: дрожь в
       * пиксель до порога перетаскивания не доходит, а выделение тянет —
       * и оно оставалось бы ползти под тащимым пузырём (замечено
       * владельцем в 153). Взят — значит выделять человек не хотел.
       * Уже выделенный кусок сюда не попадает: нажатие внутри выделения
       * задержку не запускает вовсе.
       */
      window.getSelection()?.removeAllRanges();
    }, правило.delayMs);

    нажатие = своё;
  }, true);

  document.addEventListener('pointermove', (event) => {
    if(!нажатие || нажатие.итог !== 'wait') return;

    const правило = правилоЗадержки();
    const сдвиг = правило?.shift(event.clientX - нажатие.x0, event.clientY - нажатие.y0, window.devicePixelRatio) ?? 0;
    нажатие.сдвиг = Math.max(нажатие.сдвиг, сдвиг);
  }, true);

  /*
   * Снимаем по отпусканию и по концу перетаскивания. По pointercancel — нет:
   * Chromium шлёт его, когда перетаскивание уже началось, и отметка «взят»
   * нужна воротам до самого dragstart.
   */
  document.addEventListener('pointerup', отпустить, true);
  document.addEventListener('dragend', отпустить, true);
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
    const target = event.target as Node;
    const bubble = пузырьОт(target);
    if(!bubble || !event.dataTransfer) return;

    /*
     * Тащат выделенный текст, а не пузырь (153). Браузер начинает такое
     * перетаскивание сам, без задержки, и цель у него — текст, а не
     * пузырь. Кусок одного сообщения едет куском; выделение через два и
     * больше — целыми сообщениями (решение владельца при плане 153).
     */
    const выбор = выделенное();
    const тащатВыделение = выбор !== null &&
      target !== bubble &&
      window.getSelection().getRangeAt(0).intersectsNode(target);

    /*
     * Ворота задержки (153): пузырь, который не подержали, не тащится —
     * отменяем, и Chromium ведёт выделение текста дальше.
     */
    if(!тащатВыделение && правилоЗадержки() && нажатие?.итог !== 'lift') {
      event.preventDefault();
      if(нажатие) {
        clearTimeout(нажатие.таймер);
        нажатие.итог = 'select';
      }
      return;
    }

    /*
     * Тащат взятый пузырь, а не выделенное: выделение, если успело
     * нарасти между «взят» и порогом, снимаем — по той же причине.
     */
    if(!тащатВыделение && нажатие?.итог === 'lift') window.getSelection()?.removeAllRanges();

    let payloads: any[];

    if(тащатВыделение) {
      payloads = выбор.bubbles.length === 1 ?
        нагрузкиИз([выбор.bubbles[0]]).map((payload): any => ({...payload, quote: выбор.text})) :
        нагрузкиИз(выбор.bubbles);
    } else {
      /*
       * Пачку собираем из выделенного штатными средствами Web K. Выделения
       * нет — уходит один пузырь, тот, за который взялись.
       */
      const picked = [...document.querySelectorAll('.bubble.is-selected[data-piloot-payload]')] as HTMLElement[];
      payloads = нагрузкиИз(picked.length > 1 ? picked : [bubble]);
    }

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

/**
 * Свайп сообщения вправо — в панель (Piloot 164).
 *
 * Зеркало свайпа «Ответить» самого Web K (`attachReplyWheelSwipe` и
 * `createReplySwipeController` в `components/chat/bubbles.ts`): у него
 * пальцы по трекпаду влево открывают ответ, у нас пальцы вправо — в
 * сторону панели — кладут сообщение туда же, куда пункт «Send to Piloot».
 *
 * Трекпад шлёт жест событиями прокрутки. Слушаем их на документе, раньше
 * слушателя Web K на ленте: жест вправо над подходящим пузырём забираем
 * целиком, и до Web K он не доходит; любой другой жест пропускаем
 * нетронутым — ответ влево и прокрутка работают как прежде. Направление,
 * порог и конец жеста считает правило панели (`src/shared/swipe.ts`
 * Piloot), здесь — только разметка и движение.
 *
 * Движение — его же средствами и числами: тот же класс перехода, тот же
 * помощник на 250 мс, сдвиг строкой стиля, вместе с аватаркой группы.
 * Значка внутрь пузыря не вставляем (правило 12 Piloot): пузырь получает
 * атрибуты `data-piloot-swipe` и `data-piloot-swipe-hiding`, значок рисует
 * слой стилей Piloot.
 *
 * Проверку «в чат можно писать» у Web K не повторяем: тикет делается и из
 * канала, как пунктом меню (решение владельца при плане 164).
 *
 * В режиме выделения (168) свайп по выделенному уносит все выделенные
 * разом и снимает выделение; по невыделенному его нет.
 */
function правилоСвайпа(): any {
  return (window.parent as any).pilootForWebk?.swipe;
}

function swipeToPanel() {
  const КЛАСС = 'is-gesturing-reply';

  let вн: Внутренности | undefined;
  void web().then((всё) => (вн = всё));

  let состояние: any = null;
  let тишина = 0;
  let пузырь: HTMLElement | undefined;
  let аватар: HTMLElement | undefined;
  let начато = false;
  let сдвиг = 0;
  /** Жест начат в режиме выделения: отпускание уносит все выделенные (168). */
  let пачкой = false;

  /** Вложенный блок (код, широкая таблица) ещё может уехать влево сам — жест его. */
  const внутриЕдетВлево = (from: HTMLElement, до: HTMLElement): boolean => {
    for(let element = from; element && element !== до; element = element.parentElement) {
      if(element.scrollWidth > element.clientWidth && element.scrollLeft > 0) {
        const overflowX = getComputedStyle(element).overflowX;
        if(overflowX === 'auto' || overflowX === 'scroll') return true;
      }
    }

    return false;
  };

  /** Годится ли пузырь под пальцами. Разметку не трогаем: касание без движения следа не оставляет. */
  const найти = (target: HTMLElement): boolean => {
    const chat = вн?.appImManager?.chat;
    if(!chat || !вн) return false;
    if(chat.type === 'pinned' || chat.type === 'logs') return false;

    const bubble = target.closest?.('.bubble[data-mid]') as HTMLElement | null;
    const лента = bubble?.closest('.bubbles') as HTMLElement | null;
    if(!bubble || !лента) return false;
    if(['service', 'is-sending', 'is-sponsored', 'is-date'].some((name) => bubble.classList.contains(name))) return false;
    if(внутриЕдетВлево(target, лента)) return false;

    /*
     * Режим выделения (168): свайп только по выделенному — он уносит все
     * выделенные разом, как бросок пачки. По невыделенному жест целиком
     * уходит прокрутке, и ничего не случается.
     */
    const выделение = chat.selection?.isSelecting === true;
    if(выделение && !bubble.classList.contains('is-selected')) return false;

    пузырь = bubble;
    аватар = undefined;
    начато = false;
    сдвиг = 0;
    пачкой = выделение;

    /*
     * Аватарка едет с пузырём только вне выделения. В выделении Web K
     * держит её своим сдвигом и уменьшением, и наш сдвиг строкой стиля их
     * сбил бы; к тому же едет только пузырь под пальцами (168).
     */
    try {
      const свой = bubble.parentElement?.querySelector('.bubbles-group-avatar') as HTMLElement | null;
      if(!выделение && свой && вн.getVisibleRect(свой, bubble)) аватар = свой;
    } catch(err) {}

    return true;
  };

  const двигать = (offset: number, правило: any) => {
    if(!пузырь || !вн) return;

    if(!начато) {
      начато = true;

      /*
       * В выделении Web K сдвигает содержимое входящего пузыря, и коробка
       * содержимого становится точкой отсчёта для значка. Говорим слою
       * стилей, на сколько она ушла от края пузыря, — значок встанет туда
       * же, где стоит вне выделения (168).
       */
      const коробка = пузырь.querySelector('.bubble-content-wrapper');
      if(пачкой && коробка) {
        const уход = коробка.getBoundingClientRect().left - пузырь.getBoundingClientRect().left;
        пузырь.style.setProperty('--piloot-swipe-shift', `${Math.round(уход)}px`);
      }

      for(const element of [пузырь, аватар].filter(Boolean)) {
        вн.SetTransition({element, className: КЛАСС, forwards: true, duration: 250});
        void element.offsetLeft;
      }
    }

    сдвиг = offset;
    /* Как у него: дошёл до порога — значок виден до конца жеста, даже если пальцы вернулись. */
    const виден = пузырь.getAttribute('data-piloot-swipe') === 'ready' || правило.commits(offset);
    пузырь.removeAttribute('data-piloot-swipe-hiding');
    пузырь.setAttribute('data-piloot-swipe', виден ? 'ready' : 'on');
    пузырь.style.setProperty('--piloot-swipe-opacity', String(правило.iconOpacity(offset)));

    const transform = `translateX(${offset}px)`;
    пузырь.style.transform = transform;
    if(аватар) аватар.style.transform = transform;
    вн.cancelContextMenuOpening();
  };

  const закончить = (правило: any) => {
    const bubble = пузырь;
    const свой = аватар;
    const итог = начато && правило.commits(сдвиг);

    пузырь = аватар = undefined;
    if(!bubble || !начато || !вн) return;
    начато = false;

    /* Значок гаснет, пока пузырь едет назад, а не пропадает одним кадром. */
    bubble.setAttribute('data-piloot-swipe-hiding', '');

    [bubble, свой].filter(Boolean).forEach((element, номер) => {
      вн.SetTransition({
        element,
        className: КЛАСС,
        forwards: false,
        duration: 250,
        onTransitionEnd: номер === 0 ? () => {
          if(!bubble.hasAttribute('data-piloot-swipe-hiding')) return;
          bubble.removeAttribute('data-piloot-swipe');
          bubble.removeAttribute('data-piloot-swipe-hiding');
          bubble.style.removeProperty('--piloot-swipe-opacity');
          bubble.style.removeProperty('--piloot-swipe-shift');
        } : undefined
      });
    });

    вн.fastRaf(() => {
      bubble.style.transform = '';
      if(свой) свой.style.transform = '';
    });

    if(!итог) return;

    if(пачкой) {
      void отдатьВыделенные();
      return;
    }

    const peerId = bubble.dataset.peerId?.toPeerId?.() ?? вн.appImManager.chat?.peerId;
    const mid = Number(bubble.dataset.mid);
    if(!peerId || !mid) return;

    void вн.rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid).then((message: any) => {
      /* Как у пункта меню: только настоящее сообщение. */
      if(message?._ !== 'message') return;

      return messagePayload(peerId, mid).then((payload) => {
        if(payload) window.parent.postMessage({[MARK]: 1, event: 'ticket', payloads: [payload]}, '*');
      });
    });
  };

  /*
   * Все выделенные — одной вестью, как пункт меню при выделении; порядок
   * по времени, название из самого раннего — дело панели. Затем выделение
   * снимается тем же вызовом, каким Web K снимает его после «Переслать».
   */
  const отдатьВыделенные = async() => {
    const chat = вн?.appImManager?.chat;
    const выделенные: Map<any, Set<number>> | undefined = chat?.selection?.selectedMids;
    if(!chat || !вн || !выделенные?.size) return;

    const пары = [...выделенные].flatMap(([peerId, mids]) => [...mids].map((mid) => ({peerId, mid})));
    const найденные = await Promise.all(пары.map(async({peerId, mid}) => {
      const message: any = await вн.rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
      return message?._ === 'message' ? messagePayload(peerId, mid) : null;
    }));
    const payloads = найденные.filter(Boolean);

    if(payloads.length) window.parent.postMessage({[MARK]: 1, event: 'ticket', payloads}, '*');
    chat.selection.cancelSelection();
  };

  const тихо = (правило: any) => {
    clearTimeout(тишина);
    тишина = window.setTimeout(() => {
      закончить(правило);
      состояние = null;
    }, правило.idleMs);
  };

  document.addEventListener('wheel', (event: WheelEvent) => {
    const правило = правилоСвайпа();
    if(!правило) return;

    состояние ??= правило.start();

    const шаг = правило.step(состояние, {
      dx: правило.pixels(event.deltaX, event.deltaMode, document.documentElement.clientWidth),
      dy: event.deltaY,
      modifier: event.ctrlKey || event.metaKey || event.shiftKey
    }, () => найти(event.target as HTMLElement));

    состояние = шаг.state;

    if(шаг.action === 'ignore') return;

    тихо(правило);
    if(шаг.action === 'pass') return;

    /* Жест наш: ни прокрутке, ни ответу Web K он не достаётся. */
    event.preventDefault();
    event.stopPropagation();

    if(шаг.action === 'swallow') return;

    двигать(состояние.offset, правило);
    if(шаг.action === 'release') закончить(правило);
  }, {passive: false, capture: true});
}

/*
 * ── Тикет обратно в чат (Piloot 167) ────────────────────────────────────
 *
 * Панель просит вставить текст тикета в поле ввода открытого чата. Мостик
 * ставит его к набранному — с новой строки, набранное не стирается — и
 * оставляет курсор в поле. Сам ничего не отправляет: «Отправить» нажимает
 * человек (правило 2 Piloot).
 *
 * Средства — самого поля Web K: «можно ли писать» (`canSendPlain`), курсор
 * в конец (`placeCaretAtEnd`) и вставка в место курсора (`insertAtCaret` без
 * подсказок). Замена значения целиком (`setInputValue`) потеряла бы
 * форматирование набранного.
 *
 * После вставки мостик следит за этим чатом и говорит панели одно из двух:
 * «отправлено» — с отправленным сообщением, как у броска, — или «поле
 * опустело без отправки». Отправка сама очищает поле раньше, чем сервер
 * ответит, поэтому пустое поле ждёт полсекунды: пришла весть Web K
 * «добавлено в историю» от меня в этот чат — это отправка.
 */
type Слежка = {peerId: any, отправляется: boolean, таймер: number};

let слежка: Слежка | null = null;

async function можноПисать(): Promise<boolean> {
  const {appImManager} = await web();
  const chat = appImManager.chat;

  return !!chat?.peerId && !!chat.input?.messageInput && chat.input.canSendPlain() === true;
}

async function вставитьТекст(text: string): Promise<boolean> {
  const вн = await web();
  const chat = вн.appImManager.chat;

  if(!text || !(await можноПисать())) return false;

  const input = chat.input;
  const поле: HTMLElement = input.messageInput;
  const пусто = вн.isInputEmpty(поле);
  /* Правило — у панели: набранное не стирается, тикет — с новой строки. */
  const приставка: string = (window.parent as any).pilootForWebk?.toChat?.prefix?.(пусто) ?? (пусто ? '' : '\n');

  вн.placeCaretAtEnd(поле);
  input.insertAtCaret(приставка + text, undefined, false);
  вн.placeCaretAtEnd(поле);
  поле.focus();

  if(слежка) clearTimeout(слежка.таймер);
  слежка = {peerId: chat.peerId, отправляется: false, таймер: 0};

  return true;
}

function следитьЗаОтправкой() {
  void web().then((вн) => {
    const {rootScope, appImManager} = вн;

    /* Нажали «Отправить»: сообщение от меня легло в историю этого чата. */
    rootScope.addEventListener('history_append', ({message}: any) => {
      if(!слежка || !message?.pFlags?.out || message.peerId !== слежка.peerId) return;
      слежка.отправляется = true;
    });

    /* Сервер принял: настоящий номер — и сообщение уходит в источники. */
    rootScope.addEventListener('message_sent', ({message, mid}: any) => {
      const своя = слежка;
      const peerId = message?.peerId;
      if(!своя || peerId !== своя.peerId) return;

      clearTimeout(своя.таймер);
      слежка = null;

      void messagePayload(peerId, mid ?? message.mid).then((payload) => {
        if(payload) window.parent.postMessage({[MARK]: 1, event: 'ticketSent', payload}, '*');
      });
    });

    /* Поле опустело — ждём полсекунды: не отправка ли это. */
    document.addEventListener('input', (event) => {
      const своя = слежка;
      const поле = appImManager.chat?.input?.messageInput;
      if(!своя || !поле || event.target !== поле) return;
      if(appImManager.chat.peerId !== своя.peerId || !вн.isInputEmpty(поле)) return;

      clearTimeout(своя.таймер);
      своя.таймер = window.setTimeout(() => {
        if(слежка !== своя || своя.отправляется) return;
        слежка = null;
        void kindOf(своя.peerId).then((kind) => {
          window.parent.postMessage({[MARK]: 1, event: 'ticketCleared', chatId: String(своя.peerId), kind}, '*');
        });
      }, 500);
    }, true);
  });
}

/*
 * Бросок строки тикета на переписку (Piloot 167). Тип данных свой: Web K
 * отзывается только на файлы и наш бросок пропускает. Чат не открыт или
 * писать нельзя — бросок не принимается. Отпустили — панель узнаёт, какой
 * тикет, и сама просит вставить текст.
 */
const TICKET_MIME = 'application/x-piloot-ticket';

function принятьТикеты() {
  let можно = false;

  const наш = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes(TICKET_MIME);

  document.addEventListener('dragenter', (event) => {
    if(!наш(event)) return;
    void можноПисать().then((ответ) => (можно = ответ));
  }, true);

  document.addEventListener('dragover', (event) => {
    if(!наш(event) || !можно) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, true);

  document.addEventListener('drop', (event) => {
    if(!наш(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if(!можно) return;

    const key = event.dataTransfer.getData(TICKET_MIME);
    if(key) window.parent.postMessage({[MARK]: 1, event: 'ticketDropped', key}, '*');
  }, true);
}

/*
 * Web K узнал, что у сообщений поменялись реакции (Piloot 166): личные
 * чаты, малые группы, открытый чат (его Web K сам опрашивает каждые 10 с).
 * Панели — номера, вид чата и, если короткий список внутри сообщения
 * полон, сами реакции: тогда панели не нужно спрашивать Telegram ещё раз.
 * Чьи это источники и что делать, решает она.
 */
function реакцииИзПамяти(message: any, личный: boolean) {
  const реакции = message?.reactions;
  const listed = личный || !!реакции?.pFlags?.can_see_list;
  if(!реакции) return {listed, reactions: [] as any[]};
  if(!listed) return {listed, reactions: [] as any[]};

  const эмодзи = (реакции.results ?? [])
  .filter((one: any) => one?.reaction?._ === 'reactionEmoji')
  .reduce((сумма: number, one: any) => сумма + (one.count ?? 0), 0);
  const список = (реакции.recent_reactions ?? []).filter((one: any) => one?.reaction?._ === 'reactionEmoji');
  if(список.length < эмодзи) return undefined;

  return {
    listed,
    reactions: список
    .filter((one: any) => one?.peer_id?._ === 'peerUser')
    .map((one: any) => ({userId: String(one.peer_id.user_id), emoji: String(one.reaction.emoticon), date: Number(one.date) || 0}))
  };
}

function следитьЗаРеакциями() {
  void web().then(({rootScope}) => {
    rootScope.addEventListener('messages_reactions', (items: any[]) => {
      void Promise.all((items ?? []).map(async({message}: any) => {
        if(!message?.peerId || !Number.isInteger(message.mid)) return null;
        const kind = await kindOf(message.peerId);
        return {
          chatId: String(message.peerId),
          messageId: String(message.mid),
          kind,
          seen: реакцииИзПамяти(message, kind === 'user')
        };
      })).then((найдено) => {
        const сообщения = найдено.filter(Boolean);
        if(сообщения.length) window.parent.postMessage({[MARK]: 1, event: 'reactions', messages: сообщения}, '*');
      });
    });
  });
}

/*
 * Чат бота Piloot (Piloot 174): новые сообщения одного чата — входящие и
 * отправленные человеком. Входящее с ключом панель передаёт главному
 * процессу; отправленное «/start» запускает у неё отсчёт ожидания. Сами
 * ничего не отправляем, не нажимаем и прочитанным не отмечаем.
 */
let слушаемБота: string | null = null;

function следитьЗаБотом() {
  void web().then(({rootScope}) => {
    const уже = new Set<string>();
    const передать = (message: any) => {
      if(!слушаемБота || message?._ !== 'message' || String(message.peerId) !== слушаемБота) return;
      const out = !!message.pFlags?.out;
      /* У отправляемого номер пока временный, дробный: ему номер и не нужен. */
      if(!out && !Number.isInteger(message.mid)) return;

      const метка = `${out ? 'o' : 'i'}:${message.mid}`;
      if(уже.has(метка)) return;
      уже.add(метка);
      if(уже.size > 200) уже.clear();

      window.parent.postMessage({
        [MARK]: 1,
        event: 'botMessage',
        chatId: слушаемБота,
        messageId: String(message.mid),
        out,
        text: String(message.message ?? '')
      }, '*');
    };

    rootScope.addEventListener('history_multiappend', (message: any) => передать(message));
    rootScope.addEventListener('history_append', ({message}: any) => передать(message));
  });
}

if(framed) {
  /*
   * Зеркало передаём не сообщением, а прямым вызовом: холст через
   * postMessage не проходит, а окна у нас одного происхождения — Piloot
   * достаёт до этой функции так же, как он уже читает наши переменные темы.
   */
  (window as any).pilootBackground = {mirror: зеркалоГрадиента};

  listen();
  следитьЗаВидом();

  /*
   * Всё, что трогает внутренности Web K, — только после входа (156): тема,
   * смена чата, перетаскивание, задержка броска, пункт меню сообщения,
   * свайп вправо (164), тикет обратно в чат (167), реакции (166), чат
   * бота (174).
   */
  void входПроизошёл.then(() => {
    следитьЗаТемойИЧатом();
    makeDraggable();
    holdToThrow();
    addTicketItem();
    swipeToPanel();
    следитьЗаОтправкой();
    принятьТикеты();
    следитьЗаРеакциями();
    следитьЗаБотом();
  });
}
