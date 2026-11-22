FROM node:20-alpine

WORKDIR /app

# 零依赖：只拷源码，不跑 npm install
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV PORT=3000 NODE_ENV=production
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
