const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { defaultLogger: logger } = require('./logger'); // Import logger from separate file
require('dotenv').config();

const app = express();
const serverPort = 4000; // Puerto donde correrá el servidor de gestión
let activeRequests = 0

const projectTemplatePath = path.join(__dirname, '..', 'chat-bot-whatsapp');
const clientsBasePath = path.join(__dirname, '..', 'clientes_chatbot');

// Middleware para parsear el cuerpo de la petición (JSON)
app.use(express.json());

// Función para crear un nuevo cliente
const cloneAndSetupBot = async (client, port) => {
    const clientPath = path.join(clientsBasePath, `cliente_${client.id}`);

    // Verificar si la carpeta ya existe
    if (fs.existsSync(clientPath)) {
        logger.warn(`La carpeta ya existe para el cliente: ${client.name}`, { clientPath });
        throw new Error(`La carpeta para ${client.name} ya existe.`);
    }

    logger.info(`Clonando plantilla a la carpeta del cliente`, { from: projectTemplatePath, to: clientPath });
    execSync(`rsync -a ${projectTemplatePath}/ ${clientPath}/`);

    const envPath = path.join(clientPath, '.env');
    logger.info(`Configurando variables de entorno`, { envPath });

    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
        logger.debug(`Archivo .env existente encontrado`, { content: envContent });
    }

    const updateEnvVariable = (variable, value) => {
        logger.debug(`Actualizando variable de entorno`, { variable, value });
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
    logger.info(`Variables de entorno actualizadas exitosamente`);

    const pm2Name = `bot-${client.name}`;
    logger.info(`Cambiando directorio a la ruta del cliente`, { clientPath });
    process.chdir(clientPath);

    logger.info(`Eliminando sesiones existentes del bot`);
    execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });

    logger.info(`Iniciando bot con PM2`, { pm2Name });
    execSync(`pm2 start app.js --name ${pm2Name} --max-memory-restart=2G`, {
        stdio: 'inherit'
    });
    logger.info(`Guardando configuración de PM2`);
    execSync(`pm2 save --force`, {
        stdio: 'inherit'
    });
    logger.info(`Configuración del bot completada exitosamente`, { client: client.name, port });
    // Start gestor_clientes after 5 seconds without blocking execution
    setTimeout(() => {
        execSync(`pm2 start gestor_clientes`, { stdio: 'inherit' });
    }, 5000);
};

app.post('/clientes/create', async (req, res) => {
    const { id, name, email, port } = req.body;
    logger.info('Solicitud de creación de cliente recibida', { id, name, email, port });

    if (!id || !name || !email || !port) {
        logger.warn('Faltan parámetros requeridos', { id, name, email, port });
        return res.status(400).json({ error: 'Faltan parámetros (id, name, email, port)' });
    }

    try {
        const client = { id, name, email };
        logger.info('Iniciando proceso de creación del cliente', { client });
        await cloneAndSetupBot(client, port);
        logger.info('Cliente creado exitosamente', { client: name, port });
        res.status(200).json({ message: `Cliente ${name} creado e iniciado en el puerto ${port}` });
    } catch (error) {
        logger.error('Error al crear cliente:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/change-status', async (req, res) => {
    const { id, name, command } = req.body;
    logger.info('Solicitud de inicio de cliente recibida', { id, name });

    if (!id || !name || !command) {
        logger.warn('Faltan parámetros requeridos', { id, name,command });
        return res.status(400).json({ error: 'Faltan parámetros (id, name,command)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);
    logger.info('Verificando ruta del cliente', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Carpeta del cliente no encontrada', { clientPath });
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        logger.info('Iniciando cliente con PM2', { pm2Name, clientPath });
        process.chdir(clientPath);
        execSync(`pm2 ${command} ${pm2Name}`, {
            stdio: 'inherit'
        });
        logger.info('Cliente '+command+' exitosamente', { client: name });
        res.status(200).json({ message: `Cliente ${name} ${command} en PM2` });
    } catch (error) {
        logger.error('Error al '+command+' cliente:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/reset', async (req, res) => {
    const { id, name } = req.body;
    logger.info('Solicitud de detención de cliente recibida', { id, name });

    if (!id || !name) {
        logger.warn('Faltan parámetros requeridos', { id, name });
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);
    logger.info('Verificando ruta del cliente', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Carpeta del cliente no encontrada', { clientPath });
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        logger.info('Deteniendo cliente con PM2', { pm2Name, clientPath });
        process.chdir(clientPath);
        execSync(`pm2 stop ${pm2Name}`, {
            stdio: 'inherit'
        });
        logger.info('Guardando configuración de PM2');
        logger.info('Eliminando sesiones del bot');
        execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });
        logger.info('Iniciando cliente con PM2', { pm2Name, clientPath });
        execSync(`pm2 start ${pm2Name}`, {
            stdio: 'inherit'
        });
        logger.info('Cliente reset exitosamente', { client: name });
        res.status(200).json({ message: `Cliente ${name} detenido PM2` });
    } catch (error) {
        logger.error('Error al reset cliente:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.post('/clientes/delete', async (req, res) => {
    const { name } = req.body;
    logger.info('Solicitud de eliminación de cliente recibida', { name });

    if (!name) {
        logger.warn('Falta parámetro requerido', { name });
        return res.status(400).json({ error: 'Faltan parámetros (name)' });
    }

    activeRequests++;

    const clientPath = path.join(clientsBasePath, `cliente_${name}`);
    logger.info('Verificando ruta del cliente', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Carpeta del cliente no encontrada', { clientPath });
        return res.status(404).json({ error: `Cliente con ID ${name} no encontrado.` });
    }

    try {
        logger.info('Eliminando cliente de PM2', { name });
        execSync(`pm2 delete bot-${name}`, { stdio: 'inherit' });
        logger.info('Guardando configuración de PM2');
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        logger.info('Eliminando directorio del cliente', { clientPath });
        fs.rmSync(clientPath, { recursive: true, force: true });
        logger.info('Cliente eliminado exitosamente', { client: name });
        activeRequests--;
        res.status(200).json({ message: `Cliente con ID ${name} eliminado exitosamente.` });
        // Start gestor_clientes after 5 seconds without blocking execution
        setTimeout(() => {
            if (activeRequests === 0) {
                execSync(`pm2 start gestor_clientes`, { stdio: 'inherit' });
            } else {
                logger.info(`Aún hay ${activeRequests} solicitudes en curso, esperando...`, { client: name });
            }
        }, 5000);
    } catch (error) {
        logger.error('Error al eliminar cliente:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

app.get('/clientes/status', (req, res) => {
    logger.info('Solicitud de estado recibida');
    try {
        logger.debug('Ejecutando comando PM2 jlist');
        const output = execSync('pm2 jlist', { encoding: 'utf-8' });
        const pm2List = JSON.parse(output);
        logger.info('Lista de procesos PM2 obtenida exitosamente', { processCount: pm2List.length });

        const formattedList = pm2List.map(proc => ({
            name: proc.name,
            status: proc.pm2_env.status,
            port: proc.pm2_env.env.PORT || 'N/A',
            uptime: proc.pm2_env.pm_uptime ? new Date(proc.pm2_env.pm_uptime).toLocaleString() : 'N/A',
            memory: `${(proc.monit.memory / 1024 / 1024).toFixed(2)} MB`,
            cpu: `${proc.monit.cpu}%`
        }));

        logger.debug('Lista de procesos formateada', { processes: formattedList });
        res.status(200).json(formattedList);
    } catch (error) {
        logger.error('Error al obtener estado de PM2:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Error al obtener estado de PM2' });
    }
});

app.get('/clientes/logs/:appName', (req, res) => {
    const appName = req.params.appName;
    const timeout = 5000;
    logger.info('Solicitud de logs recibida', { appName, timeout });

    if (!appName) {
        logger.warn('Falta nombre de aplicación');
        return res.status(400).json({ error: 'Debe proporcionar un nombre de aplicación' });
    }

    try {
        logger.info('Iniciando stream de logs PM2', { appName });
        const logStream = spawn('pm2', ['logs', appName]);

        res.setHeader('Content-Type', 'text/plain');

        logStream.stdout.on('data', (data) => {
            logger.debug('Datos recibidos de stdout', { appName });
            res.write(data.toString());
        });

        logStream.stderr.on('data', (data) => {
            logger.debug('Datos recibidos de stderr', { appName });
            res.write(data.toString());
        });

        const timeoutId = setTimeout(() => {
            logger.info('Tiempo de espera del stream de logs alcanzado', { appName, timeout });
            logStream.kill();
            res.end(`\nConexión cerrada después de ${timeout / 1000} segundos.`);
        }, timeout);

        logStream.on('close', () => {
            logger.info('Stream de logs cerrado', { appName });
            clearTimeout(timeoutId);
            res.end(`\nProceso de logs cerrado.`);
        });

    } catch (error) {
        logger.error('Error al obtener logs:', { error: error.message, appName, stack: error.stack });
        res.status(500).json({ error: 'Error al obtener logs' });
    }
});




app.post('/clientes/bot-conextion', async (req, res) => {
    const { id, name } = req.body;
    logger.info('Solicitud estado de conexion', { id, name });

    if (!id || !name) {
        logger.warn('Faltan parámetros requeridos', { id, name });
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);
    logger.info('Verificando ruta del cliente', { clientPath });

    if (!fs.existsSync(clientPath)) {
        logger.warn('Carpeta del cliente no encontrada', { clientPath });
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        process.chdir(clientPath);
        // Check if bot_sessions directory exists and count sessions
        let sessionCount = 0;
        try {
            sessionCount = parseInt(execSync('ls -1 bot_sessions/ | wc -l', { encoding: 'utf-8' }).trim());
            logger.info('Number of files:', { sessionCount });
        } catch (error) {
            logger.warn('No bot_sessions directory found or empty');
        }

        logger.info('Cliente status conexion', { 
            client: name, 
            sessionStatus: (sessionCount > 1 ? 'Conectado' : 'Desconectado'),
        });
        res.status(200).json({ message: `Cliente ${name} status conexion`,sessionStatus: (sessionCount > 1 ? 'Conectado' : 'Desconectado') });
    } catch (error) {
        logger.error('Error status conexion cliente:', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});



app.post('/clientes/rebot-pm2-all', async (req, res) => {
    logger.info('Iniciando Reboot de todos los clientes');
    try {
        execSync(`pm2 ls | grep 'bot-' | awk '{print $4}' | xargs -I {} pm2 stop {} `, { encoding: 'utf-8' });
        execSync(`pm2 ls | grep 'bot-' | awk '{print $4}' | xargs -I {} pm2 start {} `, { encoding: 'utf-8' });
        logger.info('Reboot exitoso');
        res.status(200).json({ message: `Reboot exitoso` });
    } catch (error) {
        logger.error('Error Reboot', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});


app.post('/clientes/reset-johana', async (req, res) => {
    const botName = 'bot-johannarubiocoppola';
    logger.info(`Iniciando Reboot de ${botName}`);
    
    try {
        const clientPath = path.join(clientsBasePath, 'cliente_johannarubiocoppola');
        //process.chdir(clientPath); // Cambiar al directorio del cliente

        const pm2 = spawn('pm2', [
            'start', 'app.js',
            '--name=bot-johannarubiocoppola',
            '--max-memory-restart', '3G',
            '--no-autorestart'
          ], { cwd: clientPath });
          
          pm2.stdout.on('data', (data) => console.log(data.toString()));
          pm2.stderr.on('data', (data) => console.error(data.toString()));
          
          pm2.on('close', (code) => {
            console.log(`PM2 proceso terminado con código ${code}`);
          });

        //execSync('/bin/bash -c ./start-pm2.sh', { stdio: 'inherit' });
/*
        execSync(`pm2 delete ${botName} || true`, { stdio: 'inherit' });
        execSync(`pm2 start ecosystem.config.js --only ${botName}`, { stdio: 'inherit' });
        execSync('pm2 save', { stdio: 'inherit' });
*/
        logger.info(`Reboot ${botName} exitoso`);
        res.status(200).json({ message: `Reboot exitoso` });
    } catch (error) {
        logger.error(`Error Reboot ${botName}`, {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: error.message });
    }
});



app.post('/clientes/pm2-max-memory', async (req, res) => {
    logger.info('Iniciando pm2-max-memory');
    try {
        const output = execSync("pm2 ls | grep 'bot-' | awk '{print $4}'", { encoding: 'utf-8' });
        logger.info('PM2 bot processes:', { processes: output.trim().split('\n') });

        const processes = output.trim().split('\n');
        for (const processItem of processes) {
            logger.info(`Processing PM2 restart for process: ${processItem}`);
            let processName = processItem;
            logger.info(`start replace process ${processName}`);
            processName = processName.replace('bot-', '');
            logger.info(`finish replace process ${processName}`);
            const clientPath = path.join(clientsBasePath, `cliente_${processName}`);
            // Check if start-pm2.sh exists before executing
            if (fs.existsSync(path.join(clientPath, 'start-pm2.sh'))) {
                logger.info('start-pm2.sh script found, proceeding with execution');
                logger.info(`Changing directory to client path ${clientPath}`);
                process.chdir(clientPath);
                logger.info(`Executing start-pm2.sh script ${processItem}`);
                execSync(`bash ./start-pm2.sh bot-${processName}`, { stdio: 'inherit' });
                logger.info(`PM2 restart completed for process ${processItem}`);
            } else {
                logger.warn('start-pm2.sh script not found, skipping process', { clientPath });
                continue;
            }
        }
       logger.info('pm2-max-memory all processes exitoso');
        res.status(200).json({ message: `pm2-max-memory all processes exitoso` });
    } catch (error) {
        logger.error('Error pm2-max-memory all processes ', { error: error.message, client: name, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});


app.listen(serverPort, () => {
    logger.info(`Gestor de clientes corriendo en http://localhost:${serverPort}`);
});
