const MODULE_ID = "lipatos-item-after-roll";
const pending = new Map();

const isPlayer = () => !!game.user && !game.user.isGM;

function getRoot(app, html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (app?.element instanceof HTMLElement) return app.element;
  if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
  return null;
}

function cleanText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function patchItemUseDialog(root, app) {
  if (!root || !isPlayer()) return;

  // Этот мод не меняет окна заклинаний.
  const activity = app?.activity ?? app?.document ?? app?.object;
  const item = activity?.item ?? app?.item;
  if (item?.type === "spell") return;

  // Drink -> Выпить
  for (const el of root.querySelectorAll("h1,h2,h3,h4,.subtitle,.activity-name,.window-subtitle,span,p,div")) {
    if (cleanText(el.textContent).toLowerCase() === "drink") {
      el.textContent = "Выпить";
    }
  }

  // «Использовать характеристику» -> «Использовать», убрать иконку.
  for (const button of root.querySelectorAll("button")) {
    const t = cleanText(button.textContent).toLowerCase();
    if (
      t.includes("использовать характеристику") ||
      t.includes("use feature") ||
      t.includes("use activity") ||
      t === "использовать"
    ) {
      if (button.dataset.lipatosUseLabelFixed === "1") continue;
      button.dataset.lipatosUseLabelFixed = "1";
      // Полностью заменяем содержимое кнопки, но сохраняем сам button и его обработчики.
      button.replaceChildren(document.createTextNode("ИСПОЛЬЗОВАТЬ"));
    }
  }

  // На всякий случай скрываем секцию «РАСХОД» у предметов для игроков.
  for (const el of root.querySelectorAll("legend,h3,h4,label,span,p")) {
    const t = cleanText(el.textContent).toLowerCase();
    if (t !== "расход" && t !== "consumption") continue;
    const section = el.closest("fieldset,.form-group,.card,.fieldset") ?? el.parentElement;
    if (section) section.style.setProperty("display", "none", "important");
  }
}

function patchApp(app, html) {
  if (!isPlayer()) return;
  const root = getRoot(app, html);
  if (!root) return;

  const run = () => patchItemUseDialog(root, app);
  run();

  if (!root._lipatosItemAfterRollObserver) {
    const observer = new MutationObserver(() => queueMicrotask(run));
    observer.observe(root, { childList: true, subtree: true });
    root._lipatosItemAfterRollObserver = observer;
  }
}

Hooks.on("renderApplicationV2", patchApp);
Hooks.on("renderActivityUseDialog", patchApp);

function activityKey(activity) {
  return `${activity?.actor?.uuid ?? ""}:${activity?.item?.id ?? ""}:${activity?.id ?? ""}`;
}

function isNonSpellItemActivity(activity) {
  return isPlayer()
    && !!activity?.actor
    && !!activity?.item
    && activity.item.type !== "spell";
}

function clone(obj) {
  return foundry.utils.deepClone(obj ?? {});
}

function hasDeferredItemConsumption(updates, activity) {
  if (!updates || !activity) return false;
  if (Object.keys(updates.activity ?? {}).length) return true;
  if ((updates.item ?? []).length) return true;
  if ((updates.create ?? []).length) return true;
  if ((updates.delete ?? []).length) return true;
  return false;
}

// D&D5e 6.x рассчитывает consumption до последующего броска.
// Для предметов игрока забираем item/activity-часть updates и не даём системе
// применить её сразу. Actor-ресурсы не трогаем.
Hooks.on("dnd5e.activityConsumption", (activity, usageConfig, messageConfig, updates) => {
  if (!isNonSpellItemActivity(activity)) return;
  if (!hasDeferredItemConsumption(updates, activity)) return;

  const state = {
    activity,
    actor: activity.actor,
    createdAt: Date.now(),
    updates: {
      activity: clone(updates.activity),
      actor: {},
      create: clone(updates.create),
      delete: clone(updates.delete),
      item: clone(updates.item),
      rolls: []
    }
  };

  pending.set(activityKey(activity), state);

  // Не расходуем предмет сейчас.
  updates.activity = {};
  updates.item = [];
  updates.create = [];
  updates.delete = [];
});

async function commitAfterRoll(subject) {
  if (!isPlayer() || !subject) return;

  const key = activityKey(subject);
  const state = pending.get(key);
  if (!state) return;

  pending.delete(key);

  const bulk = clone(state.updates);
  const actor = state.actor;
  if (!actor) return;

  // D&D5e хранит Activity Uses внутри Item. Используем штатное преобразование
  // activity updates -> item updates, если метод доступен.
  try {
    if (Object.keys(bulk.activity ?? {}).length && typeof state.activity?._mergeActivityUpdates === "function") {
      state.activity._mergeActivityUpdates(bulk);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to merge activity updates`, err);
  }

  bulk.activity = {};

  try {
    await actor.performBulkUpdate(bulk);
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to apply deferred item consumption`, err);
    ui.notifications?.error("Не удалось списать использование предмета после броска. Сообщите ГМу.");
  }
}

// Те же точки подтверждённого броска, что уже работают в моде расхода ячеек.
for (const hook of [
  "dnd5e.rollAttack",
  "dnd5e.rollAttackV2",
  "dnd5e.rollDamage",
  "dnd5e.rollDamageV2",
  "dnd5e.rollFormula"
]) {
  Hooks.on(hook, async (rolls, data) => {
    if (rolls?.length) await commitAfterRoll(data?.subject);
  });
}

// Универсальный путь: срабатывает только когда окно броска уже подтверждено.
Hooks.on("dnd5e.postRollConfiguration", async (rolls, config) => {
  if (rolls?.length && config?.subject) {
    await commitAfterRoll(config.subject);
  }
});

// Если окно броска закрыто, commit не происходит и ресурс остаётся нетронутым.
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of pending) {
    if (now - state.createdAt > 10 * 60 * 1000) pending.delete(key);
  }
}, 60 * 1000);

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
});
