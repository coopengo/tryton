FROM node:6-alpine

COPY coog-paybox-callback /coog-paybox-callback

WORKDIR /coog-paybox-callback

RUN apk add --no-cache --virtual .build-deps wget ca-certificates make gcc g++ python linux-headers musl-dev && \
    npm install && npm run pem && \
    npm cache clean && rm -rf /root/.node-gyp && \
    apk del .build-deps
    
CMD ["node", "index.js"]
EXPOSE 3000
