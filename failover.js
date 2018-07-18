var path = require("path");
var child_process = require('child_process');
var doc = require("node-docker-api");
var config = require("./config.js");
var fs = require("fs");
var docker = new doc.Docker({ socketPath: '/var/run/docker.sock' });
var exec = require('child_process').exec;
var EosApi = require('eosjs-api');



var backUpDatabase = [];
try{
    var back = fs.readFileSync("./backup.json", "utf-8");
    if(back) backUpDatabase = JSON.parse(back);
}catch(e){

}

var eosImageTag = config.tag || "eosio/eos";
var containerName = config.name || "fullnode";
var backUpDir = config.backUpDir || "/home/ubuntu/backup/";

if(!fs.existsSync(backUpDir)){
    fs.mkdirSync(backUpDir);
}


function startEOSContainer(isFirstStart, replayMode){
    var Cmd = ["/opt/eosio/bin/nodeosd.sh", "--data-dir", "/opt/eosio/bin/data-dir"];

    if(isFirstStart){
        Cmd.push("--genesis-json");
        Cmd.push("/opt/eosio/bin/data-dir/genesis.json");
    }

    if(replayMode){
        Cmd.push("--hard-replay");
    }

    console.log("startEOSContainer", "with", Cmd);

    return docker.container.create({
        Image: eosImageTag,
        name: containerName,
        Cmd: Cmd,
        ExposedPorts: {
            "8888/tcp": {},
            "9876/tcp": {}
        },
        HostConfig: {
            Mounts: [
                {
                    "Source": config.dataDir,
                    "Target" : "/opt/eosio/bin/data-dir",
                    "Type" : "bind"
                }
            ],
            PortBindings: {
                "8888/tcp": [{
                    "HostIp": "",
                    "HostPort" : config.httpPort+""
                }],
                "9876/tcp": [{
                    "HostIp": "",
                    "HostPort" : config.p2pPort+""
                }]
            }
        }
    })
}


function runFullNode(replayMode){
    startEOSContainer(false, replayMode).then(function(container){
        console.log(containerName, "created")
        container.start().then(function(){
            console.log(containerName, "started")
        }, function(err){
            console.log(containerName, "start failed")
        })
    }, function(err){
        console.log(containerName, "create failed", err)
    })
}

function startContainer(){
    docker.container.list({
        all: true,
        name: containerName
    }).then(function(containers){
        var container = containers[0];
        var Data = container.data;
        if(Data.State == "running"){
            container.stop().then(function(){
                console.log("node stopped");
                return checkContainerLogs(container);
            }).then(function(r){
                console.log("gracefull shoutdown");
                createBackupData().then(function(){
                    startContainer();
                }, function(){
                    startContainer();
                });
            }, function(){
                console.log("faild shoutdown");
            })
        }
    })
}


function checkContainerLogs(container, time){
    return new Promise(function(resolve, reject){
        var plugin_shutdown = false, released_connection = false, replay_required = false;
        var before = 100;
        if(time){
            before = time;
        }
        if(container){
            console.log("checkContainerLogs")
            container.logs({
                since: ((Date.now() - before * 1000) / 1000),
                stdout: true,
                stderr: true
            }).then(function(stream){
                stream.on('data', function(info){
                    var log = info.toString();

                    if(log.indexOf("released connection") > -1){
                        released_connection = true;
                    }

                    if(log.indexOf("plugin_shutdown") > -1){
                        plugin_shutdown = true;
                    }

                    if(log.indexOf("replay required") > -1){
                        replay_required = true;
                    }
                })
                stream.on('end', function(){
                    if(plugin_shutdown && released_connection && !replay_required){
                        resolve("grace")
                    }else{
                        var type = "exit";
                        if(replay_required){
                            type = "replay";
                        }
                        reject(type);
                    }
                })
            })
        }
    })
}


function createBackupData(){
    return new Promise(function(resolve, reject){
        var now = Math.round(Date.now() / 1000);
        var targetDir = backUpDir+now+"/";
        var sourceDir = config.dataDir+"/";
        var dataDirName = path.basename(config.dataDir);

        fs.mkdirSync(targetDir);

        console.log("copy", sourceDir, targetDir, dataDirName);

        var cp = child_process.spawn('cp', ['-r', sourceDir, backUpDir]);

        cp.stdout.on('data', function (data) {
            console.log('stdout: ' + data);
        });

        cp.stderr.on('data', function (data) {
            console.log('stderr: ' + data);
        });

        cp.on('exit', function (code) {
            console.log('child process exited with code ' + code);
            if(code == 0){
                fs.renameSync(backUpDir+dataDirName, targetDir);
                backUpDatabase.push({
                    dir: targetDir,
                    time: now
                })

                if(backUpDatabase.length > 4){
                    var deleteData = backUpDatabase.shift();
                    if(fs.existsSync(deleteData.dir)){
                        exec('rm -r ' + deleteData.dir, function (err, stdout, stderr) {
                            console.log("delete last backup sucess", deleteData)
                        });
                    }
                }

                fs.writeFileSync("./backup.json", JSON.stringify(backUpDatabase));
                console.log("backup sucess");
                resolve()
            }else{
                console.log("backup failed");
                reject()
            }
        });
    })
}

var backupFullNodeing = false;

function backupFullNode(){
    backupFullNodeing = true;

    var filters = {};

    filters["name"] = {};
    filters["name"][containerName] = true;

    docker.container.list({
        all: true,
        filters: filters
    }).then(function(containers){
        if(containers.length){
            var container = containers[0];
            var Data = container.data;
            if(Data.State == "running"){
                container.stop().then(function(){
                    console.log("node stopped");
                    return checkContainerLogs(container);
                }).then(function(r){
                    console.log("gracefull shoutdown");
                    createBackupData().then(function(){
                        backupFullNodeing = false;
                        container.start().then(function(){
                            console.log("node started");
                        });
                    }, function(){
                        backupFullNodeing = false;
                    }).catch(function(err){
                        console.log("createBackupData failed", err);
                    });
                }, function(){
                    console.log("faild shoutdown");
                })
            }
        }else{
            console.log("container", containerName, "died");
        }
    })
}


var interval = config.backupInterval || 86400;

function tryBackUpBlocks(){

    if(backupFullNodeing){
        console.log("backup in running");
        return;
    }

    var lastTimeData = backUpDatabase[backUpDatabase.length-1];
    if(lastTimeData){
        var nextTime = (lastTimeData.time + interval) * 1000;
        var nowTime = Date.now();
        if(nowTime > nextTime){
            if(backupFullNodeing){
                console.log("backupFullNodeing", backupFullNodeing);
            }else{
                console.log("time to backup");
                backupFullNode();
            }
        }else{
            console.log("next backupTime", new Date(nextTime));
        }
    }else{
        console.log("create first backup", "nodeIsRunning", nodeIsRunning);
        var eos = EosApi({
            httpEndpoint: "http://127.0.0.1:"+config.httpPort,
            logger: {
                error: function(){}
            }
        })

        eos.getInfo({}).then(function(info){
           console.log(info);
           console.log("full node online, do first backup", "nodeIsRunning", nodeIsRunning);
           backupFullNode();
        }, function(err){
            console.log("full node down, maybe on replay.", "nodeIsRunning", nodeIsRunning);
        }).catch(function(err){
            console.log("full node down, maybe on replay.", "nodeIsRunning", nodeIsRunning);
        })
    }
}


function getLastBackupData(){
    return backUpDatabase[backUpDatabase.length-1];
}


var revoceryNodeFromLastBackupIng = false;
var inReplay = false;

function revoceryNodeFromLastBackup(container, failedType){
    return new Promise(function(resolve, reject){
        if(revoceryNodeFromLastBackupIng){
            console.log("revoceryNodeFromLastBackupIng", revoceryNodeFromLastBackupIng);
            return;
        }
        revoceryNodeFromLastBackupIng = true;
        var lastBackup = getLastBackupData();
        if(lastBackup){
            var sourceDir = lastBackup.dir;
            exec('rm -r ' + config.dataDir, function (err, stdout, stderr) {
                console.log("delete data dir", config.dataDir, err);
                var cp = child_process.spawn('cp', ['-r', sourceDir, config.dataDir]);
                cp.stdout.on('data', function (data) {
                    console.log('stdout: ' + data);
                });

                cp.stderr.on('data', function (data) {
                    console.log('stderr: ' + data);
                });

                cp.on('exit', function (code) {
                    console.log('copy process exited with code ' + code);
                    if(code == 0){
                        console.log("data copyed");
                        if(container){
                            console.log("start container");
                            container.start().then(function(){
                                console.log("container started");
                                revoceryNodeFromLastBackupIng = false;
                            });
                        }else{
                            runFullNode();
                            revoceryNodeFromLastBackupIng = false;
                        }
                    }else{
                        revoceryNodeFromLastBackupIng = false;
                    }
                });
            });
            console.log(lastBackup);
        }else{
            console.log("no backup can use");
            var replayMode = failedType == "replay";

            if(container){
                container.delete().then(function(){

                    runFullNode(replayMode);
                })
            }else{
                runFullNode(replayMode);
            }

        }
    })
}


var nodeIsRunning = false;

function nodeFailOver(){

    if(backupFullNodeing){
        console.log("backup in running");
        return;
    }

    var filters = {};

    filters["name"] = {};
    filters["name"][containerName] = true;

    docker.container.list({
        all: true,
        filters: filters
    }).then(function(containers){
        console.log("containers", containers.length);
        if(containers.length){
            var container = containers[0];
            var Data = container.data;
            if(Data.State == "running"){
                nodeIsRunning = true;
                console.log("container running", Data.Names);
            }else{
                nodeIsRunning = false;
                checkContainerLogs(container, 3600).then(function(){
                    console.log("gracefull shoutdown");
                    return container.start();
                }, function(type){
                    console.log("faild shoutdown", type);
                    revoceryNodeFromLastBackup(container, type);
                });
                console.log(Data);
            }
        }else{
            nodeIsRunning = false;
            revoceryNodeFromLastBackup();
            console.log("container", containerName, "died");
        }
    }, function(err){
        console.log(err)
    }).catch(function(err){
        console.log(err)
    })
}



setInterval(function(){
    try{
        tryBackUpBlocks();
        nodeFailOver();
    }catch(e){
        console.log("main loop", e);
    }
}, 20 * 1000)
