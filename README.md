# VPN Panel

Простая админ-панель для выдачи и управления VPN-ссылками.

## Быстрый запуск на Render

1. Создай проект Supabase.
2. Возьми одну строку подключения Postgres в Supabase: `Connect` → `Session pooler`.
3. Создай на Render Web Service из этой папки.
4. Добавь переменные из `.env.example`.
5. Запусти сервис.

Таблицы Supabase создаются автоматически при первом запуске. Вручную выполнять SQL не нужно.

Если в GitHub лежит весь проект, а не только содержимое `vpn-panel`, укажи в Render `Root Directory: vpn-panel`.

## Минимальные переменные

```env
DATABASE_URL=postgresql://...
UPSTREAM_SUBSCRIPTION_URL=https://...
```

`DATABASE_URL` — строка Postgres из Supabase. `UPSTREAM_SUBSCRIPTION_URL` — ссылка на источник с серверами. Её не добавляй в GitHub.

`SESSION_SECRET`, 3x-ui и Happ являются необязательными для простого режима. Если `SESSION_SECRET` не задан, сервис использует значение базы как внутренний ключ шифрования ссылок.

## Полная конфигурация

```env
PORT=10000
PUBLIC_BASE_URL=https://your-service.onrender.com
DATABASE_URL=
SESSION_SECRET=

# Необязательно: включается персональный режим и настоящие лимиты 3x-ui
THREEXUI_BASE_URL=https://your-3x-ui.example.com
THREEXUI_USERNAME=
THREEXUI_PASSWORD=
THREEXUI_INBOUND_IDS=1,2,3

# Необязательно: Happ Limited Links и HWID
HAPP_PROVIDER_ID=euvlYGyS
HAPP_AUTH_KEY=

# Источник серверов для простого режима или резервный источник
UPSTREAM_SUBSCRIPTION_URL=
```

## Первый вход

Открой адрес Render. Логин и пароль по умолчанию:

```text
admin / admin
```

После первого входа панель потребует установить новый пароль.

## Режимы работы

### Простой режим

Достаточно Supabase и `UPSTREAM_SUBSCRIPTION_URL`. Панель выдаёт разные защищённые ссылки, позволяет включать/отключать их, проверяет срок действия и добавляет метаданные Happ.

Если задан `HAPP_AUTH_KEY`, лимит устройств работает через Happ Limited Links даже без 3x-ui. Если у провайдера Happ нет активного API-доступа, Happ вернёт ошибку `This feature requires an active subscription` — это ограничение аккаунта Happ, которое код панели обойти не может.

В простом режиме трафик передаётся в заголовке подписки, но фактический расход невозможно измерить и заблокировать на уровне панели: панель только раздаёт конфигурацию. Для настоящего лимита ГБ и IP нужен 3x-ui или другой VPN-сервер с API статистики.

### Персональный режим 3x-ui

После заполнения `THREEXUI_*` каждая новая запись создаёт отдельного клиента 3x-ui. Лимиты трафика, срока и IP применяются на стороне VPN-серверов.

`THREEXUI_INBOUND_IDS` — числовые ID inbound через запятую, а не IP-адреса серверов.

### Happ

`HAPP_PROVIDER_ID` — Provider ID из профиля Happ. `HAPP_AUTH_KEY` — отдельный auth key из профиля Happ, он не вычисляется из Provider ID.

Если задан `HAPP_AUTH_KEY`, конечный Render-домен можно зарегистрировать в разделе `Настройки`. Ограничение установок Happ работает только при заданном конечном лимите устройств.

## Локальная проверка

```powershell
npm install
npm test
npm start
```

Проверка сервиса:

```powershell
curl.exe -i http://localhost:10000/healthz
```

Ожидаемый статус — `204 No Content`.

## Безопасность

- Не публикуй `.env`, `DATABASE_URL`, пароль 3x-ui, `HAPP_AUTH_KEY` и ссылки подписок.
- Google Drive URL хранится только в Render Environment.
- API key из ранее раскрытой Google Drive-ссылки нужно заменить или отозвать.
