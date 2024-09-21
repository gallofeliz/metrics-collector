FROM node:18-alpine AS build

WORKDIR /build

ADD package.json package-lock.json ./

RUN npm i

ADD src/ tsconfig.json bourso.sh ./

RUN npx ttsc

RUN npm prune --production

# ------------

FROM node:18-alpine

RUN apk add --no-cache tzdata curl jq

WORKDIR /app

COPY --from=build /build ./

#USER nobody

CMD ["node", "--no-warnings", "dist"]
