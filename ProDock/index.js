const express = require("express");
const managementAPI = express();
const Docker = require("dockerode");
const docker = new Docker({socketPath : "/var/run/docker.sock"})
const httpProxy = require("http-proxy");
const http = require("http");
const proxy = httpProxy.createProxy({});

const managementApiPORT = 8080;
const reverseProxyPORT = 80;

const db = new Map();
docker.getEvents((err, stream) => {
    if(err) {
        console.log(`The Error in getting events is: `, err);
        return;
    }
    stream.on("data", async chunk => {
        if(!chunk) return;
        const event = JSON.parse(chunk.toString());
        if(event.type === "container" && event.Action === "start"){
            const container = docker.getContainer(event.id);
            const containerInfo = await container.inspect();
            const containerName = containerInfo.Name.substring(1);
            const ipAddr = containerInfo.NetworkSettings.IPAddress;
            const exposedPorts = Object.keys(containerInfo.Config.ExposedPorts);
            let defaultPort = null;
            if(exposedPorts && exposedPorts.length > 0) {
                const [port, type] = exposedPorts[0].split('/');
                if(type === "tcp"){
                    defaultPort = port;
                }
            }
            console.log(`Registring container =>   ${containerName}.localhost --> http://${ipAddr}:${defaultPort}`);
            db.set(containerName, { containerName, ipAddr, defaultPort});
        }
    })
})




const reverseProxyApp = express();
reverseProxyApp.use((req,res) => {
    const hostname = req.hostname;
    const subDomain = hostname.split('.')[0];
    if(!db.has(subDomain)) return res.status(404).end(404);
    const {ipAddr, defaultPort} = db.get(subDomain);
    const target = `http://${ipAddr}:${defaultPort}`;
    console.log(`Forwarding ${hostname} --> ${target}`);
    proxy.web(req, res, {target: target, changeOrigin: true});
})

const reverseProxy = http.createServer(reverseProxyApp);

managementAPI.use(express.json());
let imageAlreadyExists = false;

managementAPI.post("/containers", async (req, res) => {
    const { image, tag = "latest" }  = req.body;
    const images = await docker.listImages();
    for(const systemImage of images) {
        for(const systemTag of systemImage.RepoTags) {
            if(systemTag === `${image}:${tag}`) {
                imageAlreadyExists = true;
                break;
            }
        }
        if(imageAlreadyExists) break;
    }
    if(imageAlreadyExists) {
        console.log(`Pulling Image ${image}:${tag}`);
        await docker.pull(`${image}:${tag}`)
    }
    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        Tty: false,
        HostConfig : {
            AutoRemove:true
        }
    })
    await container.start();
    return res.json({
        success: true,
        container : `Access your conatiner at: ${(await container.inspect()).Name}.localhost`,
    })
});

managementAPI.listen(managementApiPORT, "0.0.0.0", () => {
    console.log(`Management Api listening on port : ${managementApiPORT}`);
});

reverseProxy.listen(reverseProxyPORT, "0.0.0.0", () => {
    console.log(`Reverse proxy listening on port : ${reverseProxyPORT}`);
});