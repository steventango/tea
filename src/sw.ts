declare var self: ServiceWorkerGlobalScope;

import { precacheAndRoute } from 'workbox-precaching';
import {registerRoute} from 'workbox-routing';
import {StaleWhileRevalidate} from 'workbox-strategies';

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  ({url}) => url.origin === 'https://fonts.googleapis.com' ||
             url.origin === 'https://fonts.gstatic.com',
  new StaleWhileRevalidate({
    cacheName: 'google-fonts'
  }),
);

registerRoute(
  ({url}) => !url.pathname.endsWith('.json'),
  new StaleWhileRevalidate()
);
