# docker-eos-failover

this script use docker engine http-rest-api control docker container.

backup data-dir daily 

check node status, use backup data-dir auto recovery from a ungracefuly shutdown status

## Data directory struct

```shell
 ls  /home/ubuntu/data-dir
blocks  config.ini  contracts  genesis.json  state
```

## Config

edit config.js

## RUN
```shell
npm install
node failover.js
```
