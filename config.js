module.exports = {
    // node p2p exposed port
    p2pPort: 29876,
     // node http exposed port
    httpPort: 28888,
    dataDir: "/home/ubuntu/data-dir2",
    // image
    tag:  "eosio/eos",
    // container name
    name: "fullnode",
    // backup interval second
    backupInterval: 86400,
    // backup directory
    backUpDir: "/home/ubuntu/backup/"
}
