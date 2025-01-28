const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync,spawn } = require('child_process');
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
        throw new Error(`La carpeta para ${client.name} ya existe.`);
    }

    // Copiar la plantilla del proyecto al directorio del cliente
    //fs.cpSync(projectTemplatePath, clientPath, { recursive: true });
    execSync(`rsync -a ${projectTemplatePath}/ ${clientPath}/`);

    // Ruta al archivo .env del cliente (en la raíz de cliente_1, cliente_2, etc.)
    const envPath = path.join(clientPath, '.env');

    // Leer el contenido existente del archivo .env si existe
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
    }

    // Función para reemplazar o añadir una variable en el archivo .env
    const updateEnvVariable = (variable, value) => {
        const regex = new RegExp(`^${variable}=.*$`, 'm');  // Busca la línea exacta con la variable
        if (regex.test(envContent)) {
            // Reemplaza la línea existente de la variable
            envContent = envContent.replace(regex, `${variable}=${value}`);
        } else {
            // Si no existe la variable, la añade al final
            envContent += `\n${variable}=${value}`;
        }
    };

      // Reemplazar o añadir el valor del puerto
      updateEnvVariable('PORT', port);

      // Reemplazar o añadir el valor de EMAIL_TOKEN
      updateEnvVariable('EMAIL_TOKEN', client.email);
    
    // Escribir el contenido actualizado de vuelta en el archivo .env
    fs.writeFileSync(envPath, envContent);

    // Iniciar el bot en PM2
    const pm2Name = `bot-${client.name}`;
    process.chdir(clientPath);

    // Eliminar la carpeta bot_sessions
    execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });

    execSync(`pm2 start app.js --name ${pm2Name}`, {
        stdio: 'inherit'
    });
    execSync(`pm2 save --force`, {
        stdio: 'inherit'
    });
    console.log(`Bot de ${client.name} configurado y ejecutándose en el puerto ${port}`);
};

// Ruta para crear un nuevo cliente
app.post('/clientes/create', async (req, res) => {
    const { id, name, email, port } = req.body;

    // Validación de parámetros de entrada
    if (!id || !name || !email || !port) {
        return res.status(400).json({ error: 'Faltan parámetros (id, name, email, port)' });
    }

    try {
        const client = { id, name, email };
        await cloneAndSetupBot(client, port);
        res.status(200).json({ message: `Cliente ${name} creado e iniciado en el puerto ${port}` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Ruta para iniciar el bot de un cliente
app.post('/clientes/start', async (req, res) => {
    const { id, name } = req.body;

    if (!id || !name) {
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);

    if (!fs.existsSync(clientPath)) {
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        process.chdir(clientPath);
        execSync(`pm2 start app.js --name ${pm2Name}`, {
            stdio: 'inherit'
        });
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        res.status(200).json({ message: `Cliente ${name} iniciado en PM2` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});


// Ruta para detener el bot de un cliente
app.post('/clientes/stop', async (req, res) => {
    const { id, name } = req.body;

    if (!id || !name) {
        return res.status(400).json({ error: 'Faltan parámetros (id, name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${id}`);

    if (!fs.existsSync(clientPath)) {
        return res.status(404).json({ error: `Cliente ${name} no encontrado.` });
    }

    try {
        const pm2Name = `bot-${name}`;
        process.chdir(clientPath);
        execSync(`pm2 stop ${pm2Name}`, {
            stdio: 'inherit'
        });
        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });
        // Eliminar la carpeta bot_sessions
        execSync(`rm -rf bot_sessions`, { stdio: 'inherit' });

        res.status(200).json({ message: `Cliente ${name} detenido PM2` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Ruta para eliminar un cliente
app.post('/clientes/delete', async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Faltan parámetros (name)' });
    }

    const clientPath = path.join(clientsBasePath, `cliente_${name}`);

    if (!fs.existsSync(clientPath)) {
        return res.status(404).json({ error: `Cliente con ID ${name} no encontrado.` });
    }

    try {
        // Detener la instancia de PM2
        execSync(`pm2 delete bot-${name}`, { stdio: 'inherit' });

        execSync(`pm2 save --force`, {
            stdio: 'inherit'
        });

        // Eliminar la carpeta del cliente
        fs.rmSync(clientPath, { recursive: true, force: true });

        res.status(200).json({ message: `Cliente con ID ${name} eliminado exitosamente.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Ruta para obtener el listado de procesos activos en PM2
app.get('/clientes/status', (req, res) => {
    try {
        // Ejecutar el comando PM2 y capturar la salida
        const output = execSync('pm2 jlist', { encoding: 'utf-8' });
        const pm2List = JSON.parse(output);
        console.log('pm2List', pm2List);

        // Procesar la salida para devolver una respuesta más amigable
        const formattedList = pm2List.map(proc => ({
            name: proc.name,
            status: proc.pm2_env.status,
            port: proc.pm2_env.env.PORT || 'N/A',
            uptime: proc.pm2_env.pm_uptime ? new Date(proc.pm2_env.pm_uptime).toLocaleString() : 'N/A',
            memory: `${(proc.monit.memory / 1024 / 1024).toFixed(2)} MB`,
            cpu: `${proc.monit.cpu}%`
        }));

        res.status(200).json(formattedList);
    } catch (error) {
        console.error('Error fetching PM2 status:', error);
        res.status(500).json({ error: 'Error fetching PM2 status' });
    }
});


// Ruta para obtener los logs en tiempo real de una aplicación específica
app.get('/clientes/logs/:appName', (req, res) => {
    const appName = req.params.appName;
    const timeout = 5000; // 30 segundos

    if (!appName) {
        return res.status(400).json({ error: 'Debe proporcionar un nombre de aplicación' });
    }

    try {
        const logStream = spawn('pm2', ['logs', appName]);

        res.setHeader('Content-Type', 'text/plain');

        logStream.stdout.on('data', (data) => {
            res.write(data.toString());
        });

        logStream.stderr.on('data', (data) => {
            res.write(data.toString());
        });

        const timeoutId = setTimeout(() => {
            logStream.kill();
            res.end(`\nConexión cerrada después de ${timeout / 1000} segundos.`);
        }, timeout);

        logStream.on('close', () => {
            clearTimeout(timeoutId);
            res.end(`\nProceso de logs cerrado.`);
        });

    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Error fetching logs' });
    }
});


// Iniciar el servidor en el puerto 4000
app.listen(serverPort, () => {
    console.log(`Gestor de clientes corriendo en http://localhost:${serverPort}`);
});
