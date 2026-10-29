const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    apiVersion: env.GRAPH_API_VERSION || 'v23.0',
  },
  shop: {
    name: env.SHOP_NAME || 'AIMAG ELECTRIC',
    currency: env.CURRENCY || '₸',
    phone: env.SHOP_PHONE || '+7 705 615-17-17',
    hours: env.SHOP_HOURS || 'Пн–Пт, 09:00–18:00',
    managerPhone: env.MANAGER_PHONE || '',
  },
  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
  // Пауза перед разбором спецификации в WhatsApp: ждём, пока клиент пришлёт все фото
  specBatchMs: Number(env.SPEC_BATCH_MS ?? 6000),
  // Токен для служебных страниц (эмулятор, заявки). Если пусто — эмулятор открыт всем.
  adminToken: env.ADMIN_TOKEN || '',
  simulatorEnabled: env.SIMULATOR_ENABLED !== 'false',
  // Реквизиты продавца для КП и счёта
  company: {
    name: env.COMPANY_NAME || 'ИП «AIMAG»',
    iin: env.COMPANY_IIN || '890922301639',
    director: env.COMPANY_DIRECTOR || 'Оразбаев Е. О.',
    address: env.COMPANY_ADDRESS || 'Республика Казахстан, г. Шымкент, Байтерекова, 202',
    phone: env.COMPANY_PHONE || '+7 (705) 615-1717',
    email: env.COMPANY_EMAIL || '',
    site: env.COMPANY_SITE || 'aimag.kz',
    bank: env.COMPANY_BANK || 'АО «Банк ЦентрКредит»',
    bik: env.COMPANY_BIK || 'KCJBKZKX',
    iik: env.COMPANY_IIK || 'KZ248562204135637519',
    kbe: env.COMPANY_KBE || '',
    knp: env.COMPANY_KNP || '710',
    stampPath: env.STAMP_PATH || new URL('../templates/assets/stamp_sign.png', import.meta.url).pathname,
  },
  pricing: {
    // Цена клиенту = цена ekt.kz × (1 − EKT_UNDERCUT)
    ektUndercut: Number(env.EKT_UNDERCUT ?? 0.05),
    // Скидка AIMAG у Электрокомплекта от цены сайта (по умолчанию для всех категорий)
    ektDiscount: Number(env.EKT_DISCOUNT ?? 0.2),
    // Скидки по разделам ekt.kz: JSON {"kabel_provod":0.2,"svetilniki_lampy":0.15}
    ektDiscountByCategory: JSON.parse(env.EKT_DISCOUNT_BY_CATEGORY || '{}'),
    // Ниже этой прибыли (от закупки) позиция уходит менеджеру на подтверждение
    minMargin: Number(env.MIN_MARGIN ?? 0.1),
  },
  firecrawl: {
    apiKey: env.FIRECRAWL_API_KEY || '',
    apiUrl: env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v2/scrape',
  },
  dbPath: env.DB_PATH || new URL('../data/db.json', import.meta.url).pathname,
  shopInfoPath: env.SHOP_INFO_PATH || new URL('../data/shop-info.md', import.meta.url).pathname,
  catalogPath: env.CATALOG_PATH || new URL('../data/catalog.json', import.meta.url).pathname,
};
