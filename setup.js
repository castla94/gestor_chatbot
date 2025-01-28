const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { defaultLogger: logger } = require('./logger'); // Import logger from separate file
require('dotenv').config();

const app = express();
const serverPort = 4000; // Puerto donde correrá el servidor de gestión

const projectTemplatePath = path.join(__dirname, '..', 'chat-bot-whatsapp');
const clientsBasePath = path.join(__dirname, '..', 'clientes_chatbot');

// Middleware para parsear el cuerpo de la petición (JSON)
app.use(express.json());

// Función para crear un nuevo cliente
const cloneAndSetupBot = async (client, port) => {
    const clientPath = path.join(clientsBasePath, `cliente_${client.id}`);

    // Verificar si la carpeta ya existe
    if (fs.existsSync(clientPath)) {
        logger.warn(`Folder already exists for client: ${client.name}`, { clientPath });
        throw new Error(`La carpeta para ${client.name} ya existe.`);
    }

    logger.info(`Cloning template to client folder`, { from: projectTemplatePath, to: clientPath });
    execSync(`rsync -a ${projectTemplatePath}/ ${clientPath}/`);

    const envPath = path.join(clientPath, '.env');
    logger.info(`Setting up environment variables`, { envPath });

    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
        logger.debug(`Existing .env file found`, { content: envContent });
    }

    const updateEnvVariable = (variable, value) => {
        logger.debug(`Updating env variable`, { variable, value });
        const regex = new RegExp(`^${variable}=.*$`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${variable}=${value}`);
        } else {
            envContent += `\n${variable}=${value}`;
        }
    };

    updateEnvVariable('PORT', port);
    updateEnvVariable('EMAIL_TOKEN', client.email);
    
    fs.writeFileSync(envPath, envContent);
    logger.info(`Environment variables updated successfully`);

    const pm2Name = `bot-${client.name}`;
    logger.info(`Changing directory to client path`, { clientPath });
    process.chdir(clientPath);

    logger.info(`Removing existing bot sessions`);
    execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });

    logger.info(`Starting bot with PM2`, { pm2Name });
    execSync(`pm2 start app.js --name ${pm2Name}`, {
        stdio: 'inherit'
    });
    logger.info(`Saving PM2 configuration`);
    execSync(`pm2 save --force`, {
        stdio: 'inherit'
    });
    logger.info(`Bot setup completed successfully`, { client: client.name, port });
};

app.post('/clientes/create', async (req, res) => {
    const { id, name, email, port } = req.body;
    logger.info('Received create client request', { id, name, email, port });

    if (!id || !name || !email || !port) {
        logger.warn('Missing required parameters', { id, name, email, port });
        return res.status(400).json({ error: 'Faltan parámetros (id, name, email, port)' });
    }

    try {
        const client = { id, name, email };
        logger.info('Starting client creation process', { client });
        await cloneAndSetupBot(client, port);
        logger.info('Client created successfully', { client: name, port });
        res.status(200).json({ message: `Cliente ${name} creado e iniciado en el puerto ${port}` });
    } catch (error) {
        logger.error('Error creating client:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/start', async (req, res) => {
    const { id, name } = req.body;
    logger.info('Received start client request', { id, name });

    if (!id || !name) {
        logger.warn('Missing required parameters', { id, name });
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);
    logger.info('Checking client path', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Client folder not found', { clientPath });
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        logger.info('Starting client with PM2', { pm2Name, clientPath });
        process.chdir(clientPath);
        execSync(`pm2 start app.js --name ${pm2Name}`, {
            stdio: 'inherit'
        });
        logger.info('Saving PM2 configuration');
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        logger.info('Client started successfully', { client: name });
        res.status(200).json({ message: `Cliente ${name} iniciado en PM2` });
    } catch (error) {
        logger.error('Error starting client:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/stop', async (req, res) => {
    const { id, name } = req.body;
    logger.info('Received stop client request', { id, name });

    if (!id || !name) {
        logger.warn('Missing required parameters', { id, name });
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);
    logger.info('Checking client path', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Client folder not found', { clientPath });
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        logger.info('Stopping client with PM2', { pm2Name, clientPath });
        process.chdir(clientPath);
        execSync(`pm2 stop ${pm2Name}`, {
            stdio: 'inherit'
        });
        logger.info('Saving PM2 configuration');
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        logger.info('Removing bot sessions');
        execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });

        logger.info('Client stopped successfully', { client: name });
        res.status(200).json({ message: `Cliente ${name} detenido PM2` });
    } catch (error) {
        logger.error('Error stopping client:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/delete', async (req, res) => {
    const { name } = req.body;
    logger.info('Received delete client request', { name });

    if (!name) {
        logger.warn('Missing required parameter', { name });
        return res.status(400).json({ error: 'Faltan parámetros (name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${name}`);
    logger.info('Checking client path', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Client folder not found', { clientPath });
        return res.status(404).json({ error: `Cliente con ID ${name} no encontrado.` });
    }

    try {
        logger.info('Deleting client from PM2', { name });
        execSync(`pm2 delete bot-${name}`, { stdio: 'inherit' });
        logger.info('Saving PM2 configuration');
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        logger.info('Removing client directory', { clientPath });
        fs.rmSync(clientPath, { recursive: true, force: true });

        logger.info('Client deleted successfully', { client: name });
        res.status(200).json({ message: `Cliente con ID ${name} eliminado exitosamente.` });
    } catch (error) {
        logger.error('Error deleting client:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.get('/clientes/status', (req, res) => {
    logger.info('Received status request');
    try {
        logger.debug('Executing PM2 jlist command');
        const output = execSync('pm2 jlist', { encoding: 'utf-8' });
        const pm2List = JSON.parse(output);
        logger.info('PM2 process list retrieved successfully', { processCount: pm2List.length });

        const formattedList = pm2List.map(proc => ({
            name: proc.name,
            status: proc.pm2_env.status,
            port: proc.pm2_env.env.PORT || 'N/A',
            uptime: proc.pm2_env.pm_uptime ? new Date(proc.pm2_env.pm_uptime).toLocaleString() : 'N/A',
            memory: `${(proc.monit.memory / 1024 / 1024).toFixed(2)} MB`,
            cpu: `${proc.monit.cpu}%`
        }));

        logger.debug('Formatted process list', { processes: formattedList });
        res.status(200).json(formattedList);
    } catch (error) {
        logger.error('Error fetching PM2 status:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Error fetching PM2 status' });
    }
});

app.get('/clientes/logs/:appName', (req, res) => {
    const appName = req.params.appName;
    const timeout = 5000;
    logger.info('Received logs request', { appName, timeout });

    if (!appName) {
        logger.warn('Missing application name');
        return res.status(400).json({ error: 'Debe proporcionar un nombre de aplicación' });
    }

    try {
        logger.info('Starting PM2 logs stream', { appName });
        const logStream = spawn('pm2', ['logs', appName]);

        res.setHeader('Content-Type', 'text/plain');

        logStream.stdout.on('data', (data) => {
            logger.debug('Received stdout data', { appName });
            res.write(data.toString());
        });

        logStream.stderr.on('data', (data) => {
            logger.debug('Received stderr data', { appName });
            res.write(data.toString());
        });

        const timeoutId = setTimeout(() => {
            logger.info('Log stream timeout reached', { appName, timeout });
            logStream.kill();
            res.end(`\nConexión cerrada después de ${timeout / 1000} segundos.`);
        }, timeout);

        logStream.on('close', () => {
            logger.info('Log stream closed', { appName });
            clearTimeout(timeoutId);
            res.end(`\nProceso de logs cerrado.`);
        });

    } catch (error) {
        logger.error('Error fetching logs:', { error: error.message, appName, stack: error.stack });
        res.status(500).json({ error: 'Error fetching logs' });
    }
});

app.listen(serverPort, () => {
    logger.info(`Gestor de clientes corriendo en http://localhost:${serverPort}`);
});
