import { config } from './config.js';
import { createApp } from './app.js';

const { app, catalog, assistant, ekt } = createApp(config);

app.listen(config.port, () => {
  console.log(
    `Бот «${config.shop.name}» (${catalog.size} товаров) слушает порт ${config.port}. AI-консультант: ${assistant ? 'включён' : 'выключен'}. ` +
      `Поиск на ekt.kz: ${ekt.enabled ? 'включён' : 'выключен (нет FIRECRAWL_API_KEY)'}`,
  );
  if (config.simulatorEnabled) {
    console.log(`Эмулятор: http://localhost:${config.port}/simulator${config.adminToken ? '?token=<ADMIN_TOKEN>' : ''}`);
    if (!config.adminToken) console.warn('⚠️  ADMIN_TOKEN не задан — эмулятор доступен всем, у кого есть адрес.');
  }
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    console.warn('⚠️  WhatsApp не подключён (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID) — работает только эмулятор.');
  }
});
