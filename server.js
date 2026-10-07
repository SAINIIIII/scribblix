const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ======================================================
// SETTINGS
// ======================================================

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const TOTAL_ROUNDS = 6;
const ROUND_TIME = 60;

const WORDS = [
    "apple",
    "rocket",
    "pizza",
    "dragon",
    "castle",
    "airplane",
    "banana",
    "robot",
    "football",
    "ice cream",
    "computer",
    "rainbow",
    "camera",
    "tiger",
    "elephant",
    "spaceship",
    "school",
    "tree",
    "sun",
    "moon",
    "guitar",
    "burger",
    "car",
    "train",
    "house",
    "flower",
    "fish",
    "snowman",
    "pirate",
    "superhero",
    "telephone",
    "laptop",
    "pizza",
    "rocket",
    "cloud",
    "star",
    "pencil",
    "book",
    "chair"
];

const AVATARS = [
    { bg: "#E8EEFF", fg: "#4D63E8", mark: "●" },
    { bg: "#E7FAF1", fg: "#16A36A", mark: "◆" },
    { bg: "#FFF1E7", fg: "#E97932", mark: "▲" },
    { bg: "#F4E9FF", fg: "#8A50D8", mark: "✦" },
    { bg: "#FFF7D9", fg: "#C99400", mark: "★" },
    { bg: "#E7F7FA", fg: "#1498A8", mark: "■" },
    { bg: "#FFE8EF", fg: "#D94F78", mark: "♥" },
    { bg: "#ECECEC", fg: "#555555", mark: "◆" }
];

const rooms = new Map();

// ======================================================
// HELPERS
// ======================================================

function cleanName(value) {
    if (typeof value !== "string") {
        return "Player";
    }

    const name = value.trim().slice(0, 18);

    return name || "Player";
}

function makeAvatar(id) {
    let hash = 0;

    for (const char of id) {
        hash += char.charCodeAt(0);
    }

    return AVATARS[hash % AVATARS.length];
}

function createPlayer(id, name) {
    return {
        id,
        name: cleanName(name),
        score: 0,
        avatar: makeAvatar(id)
    };
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 5; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (rooms.has(code));

    return code;
}

function createRoom() {
    const code = generateRoomCode();

    const room = {
        code,
        players: [],
        round: 0,
        drawerId: null,
        secretWord: null,
        timeLeft: 0,
        guessedPlayers: new Set(),
        gameStarted: false,
        endingRound: false,
        timer: null,
        nextRoundTimer: null
    };

    rooms.set(code, room);

    return room;
}

function publicPlayers(room) {
    return room.players.map(player => ({
        id: player.id,
        name: player.name,
        score: player.score,
        avatar: player.avatar
    }));
}

function getRoomState(room) {
    return {
        code: room.code,
        players: publicPlayers(room),
        round: room.round,
        totalRounds: TOTAL_ROUNDS,
        drawerId: room.drawerId,
        timeLeft: room.timeLeft,
        gameStarted: room.gameStarted
    };
}

function broadcastRoom(room) {
    io.to(room.code).emit("roomState", getRoomState(room));
}

function clearTimer(room) {
    if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
    }
}

function clearNextRoundTimer(room) {
    if (room.nextRoundTimer) {
        clearTimeout(room.nextRoundTimer);
        room.nextRoundTimer = null;
    }
}

function chooseWord() {
    return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function chooseDrawer(room) {
    if (!room.players.length) {
        return null;
    }

    const index = (room.round - 1) % room.players.length;

    return room.players[index];
}

function findQuickRoom() {
    return [...rooms.values()]
        .filter(room =>
            !room.gameStarted &&
            room.players.length < MAX_PLAYERS
        )
        .sort((a, b) => b.players.length - a.players.length)[0] || null;
}

// ======================================================
// ADD PLAYER
// ======================================================

function addPlayerToRoom(socket, room, name) {
    if (!room) {
        socket.emit("errorMessage", "No room available.");
        return false;
    }

    if (room.players.length >= MAX_PLAYERS) {
        socket.emit("errorMessage", "Room is full.");
        return false;
    }

    const finalName = cleanName(name);

    const duplicate = room.players.some(
        player =>
            player.name.toLowerCase() ===
            finalName.toLowerCase()
    );

    if (duplicate) {
        socket.emit(
            "errorMessage",
            "That player name is already in this room."
        );
        return false;
    }

    const player = createPlayer(
        socket.id,
        finalName
    );

    room.players.push(player);

    socket.join(room.code);
    socket.data.roomCode = room.code;

    socket.emit("joinedRoom", {
        code: room.code
    });

    broadcastRoom(room);

    io.to(room.code).emit("systemMessage", {
        message: `${player.name} joined the room.`
    });

    if (room.players.length >= MIN_PLAYERS) {
        setTimeout(() => {
            if (
                rooms.has(room.code) &&
                !room.gameStarted &&
                room.players.length >= MIN_PLAYERS
            ) {
                startGame(room);
            }
        }, 1200);
    }

    return true;
}

// ======================================================
// GAME
// ======================================================

function startGame(room) {
    if (room.gameStarted) return;

    if (room.players.length < MIN_PLAYERS) return;

    clearTimer(room);
    clearNextRoundTimer(room);

    room.gameStarted = true;
    room.round = 0;
    room.endingRound = false;

    room.players.forEach(player => {
        player.score = 0;
    });

    startRound(room);
}

function startRound(room) {
    clearTimer(room);
    clearNextRoundTimer(room);

    room.endingRound = false;

    if (room.players.length < MIN_PLAYERS) {
        room.gameStarted = false;
        room.drawerId = null;
        room.secretWord = null;
        room.timeLeft = 0;

        broadcastRoom(room);
        return;
    }

    if (room.round >= TOTAL_ROUNDS) {
        finishGame(room);
        return;
    }

    room.round++;

    room.secretWord = chooseWord();
    room.timeLeft = ROUND_TIME;
    room.guessedPlayers = new Set();

    const drawer = chooseDrawer(room);

    if (!drawer) {
        finishGame(room);
        return;
    }

    room.drawerId = drawer.id;

    // Tell everyone whose turn it is.
    io.to(room.code).emit("roundStarted", {
        round: room.round,
        totalRounds: TOTAL_ROUNDS,
        drawerId: drawer.id,
        drawerName: drawer.name,
        timeLeft: room.timeLeft
    });

    // ONLY drawer receives actual word.
    io.to(drawer.id).emit("secretWord", {
        word: room.secretWord
    });

    // Every new round starts with a clean board.
    io.to(room.code).emit("clearBoard");

    broadcastRoom(room);

    room.timer = setInterval(() => {
        if (!rooms.has(room.code)) {
            clearTimer(room);
            return;
        }

        room.timeLeft--;

        io.to(room.code).emit(
            "timer",
            room.timeLeft
        );

        if (room.timeLeft <= 0) {
            endRound(room);
        }
    }, 1000);
}

function endRound(room) {
    if (!room || room.endingRound) return;

    room.endingRound = true;

    clearTimer(room);

    io.to(room.code).emit("roundEnded", {
        word: room.secretWord
    });

    room.nextRoundTimer = setTimeout(() => {
        room.nextRoundTimer = null;

        if (!rooms.has(room.code)) {
            return;
        }

        if (room.players.length < MIN_PLAYERS) {
            room.gameStarted = false;
            room.drawerId = null;
            room.secretWord = null;
            room.timeLeft = 0;
            room.endingRound = false;

            broadcastRoom(room);
            return;
        }

        if (room.round >= TOTAL_ROUNDS) {
            finishGame(room);
        } else {
            startRound(room);
        }
    }, 2500);
}

function finishGame(room) {
    clearTimer(room);
    clearNextRoundTimer(room);

    room.gameStarted = false;
    room.endingRound = false;

    const leaderboard = [...room.players]
        .sort((a, b) => b.score - a.score)
        .map((player, index) => ({
            position: index + 1,
            id: player.id,
            name: player.name,
            score: player.score,
            avatar: player.avatar
        }));

    io.to(room.code).emit(
        "gameFinished",
        { leaderboard }
    );

    room.drawerId = null;
    room.secretWord = null;
    room.timeLeft = 0;

    broadcastRoom(room);
}

// ======================================================
// CONNECTION
// ======================================================

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    // --------------------------------------------------
    // CREATE ROOM
    // --------------------------------------------------

    socket.on("createRoom", data => {

        const name = cleanName(data?.name);

        const room = createRoom();

        const player = createPlayer(
            socket.id,
            name
        );

        room.players.push(player);

        socket.join(room.code);
        socket.data.roomCode = room.code;

        socket.emit("roomCreated", {
            code: room.code
        });

        socket.emit("joinedRoom", {
            code: room.code
        });

        broadcastRoom(room);

        console.log(
            `Room created: ${room.code}`
        );
    });

    // --------------------------------------------------
    // NORMAL JOIN
    // --------------------------------------------------

    socket.on("joinRoom", data => {

        const code =
            typeof data?.code === "string"
                ? data.code.trim().toUpperCase()
                : "";

        const name = cleanName(data?.name);

        const room = rooms.get(code);

        if (!room) {
            socket.emit(
                "errorMessage",
                "Room not found."
            );
            return;
        }

        if (room.gameStarted) {
            socket.emit(
                "errorMessage",
                "This game has already started."
            );
            return;
        }

        addPlayerToRoom(
            socket,
            room,
            name
        );

        console.log(
            `${name} joined ${code}`
        );
    });

    // --------------------------------------------------
    // QUICK JOIN
    // --------------------------------------------------

    socket.on("quickJoin", data => {

        const name = cleanName(data?.name);

        let room = findQuickRoom();

        // No waiting room? Make one.
        if (!room) {
            room = createRoom();

            const player = createPlayer(
                socket.id,
                name
            );

            room.players.push(player);

            socket.join(room.code);
            socket.data.roomCode = room.code;

            socket.emit("roomCreated", {
                code: room.code,
                quickJoin: true
            });

            socket.emit("joinedRoom", {
                code: room.code
            });

            broadcastRoom(room);

            console.log(
                `Quick room created: ${room.code}`
            );

            return;
        }

        addPlayerToRoom(
            socket,
            room,
            name
        );

        console.log(
            `${name} quick joined ${room.code}`
        );
    });

    // --------------------------------------------------
    // CHAT
    // --------------------------------------------------

    socket.on("chat", data => {

        const roomCode = socket.data.roomCode;
        const room = rooms.get(roomCode);

        if (!room || !room.gameStarted) {
            return;
        }

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        const message =
            typeof data?.message === "string"
                ? data.message.trim().slice(0, 100)
                : "";

        if (!message) return;

        // Drawer cannot guess.
        if (player.id === room.drawerId) {

            socket.emit("systemMessage", {
                message:
                    "You are drawing this round."
            });

            return;
        }

        // Correct answer.
        if (
            room.secretWord &&
            message.toLowerCase() ===
            room.secretWord.toLowerCase()
        ) {

            if (
                room.guessedPlayers.has(
                    player.id
                )
            ) {
                return;
            }

            room.guessedPlayers.add(
                player.id
            );

            const points = Math.max(
                10,
                50 + room.timeLeft
            );

            player.score += points;

            const drawer =
                room.players.find(
                    p =>
                        p.id ===
                        room.drawerId
                );

            if (drawer) {
                drawer.score += 25;
            }

            io.to(room.code).emit(
                "correctGuess",
                {
                    playerId: player.id,
                    playerName: player.name,
                    points
                }
            );

            broadcastRoom(room);

            const guessers =
                room.players.filter(
                    p =>
                        p.id !==
                        room.drawerId
                );

            if (
                guessers.length > 0 &&
                room.guessedPlayers.size >=
                    guessers.length
            ) {

                setTimeout(() => {

                    if (
                        rooms.has(room.code)
                    ) {
                        endRound(room);
                    }

                }, 1200);
            }

            return;
        }

        io.to(room.code).emit(
            "chatMessage",
            {
                playerId: player.id,
                playerName: player.name,
                message
            }
        );
    });

    // --------------------------------------------------
    // DRAW
    // --------------------------------------------------

    socket.on("draw", data => {

        const roomCode = socket.data.roomCode;
        const room = rooms.get(roomCode);

        if (!room || !room.gameStarted) {
            return;
        }

        // ONLY current drawer.
        if (socket.id !== room.drawerId) {
            return;
        }

        if (!data) return;

        io.to(room.code).emit(
            "draw",
            {
                x: Number(data.x) || 0,
                y: Number(data.y) || 0,
                px: Number(data.px) || 0,
                py: Number(data.py) || 0,

                color:
                    typeof data.color === "string"
                        ? data.color
                        : "#111111",

                size: Math.min(
                    Math.max(
                        Number(data.size) || 4,
                        1
                    ),
                    30
                ),

                erase:
                    Boolean(data.erase)
            }
        );
    });

    // --------------------------------------------------
    // CLEAR BOARD
    // --------------------------------------------------

    socket.on("clearBoard", () => {

        const roomCode = socket.data.roomCode;
        const room = rooms.get(roomCode);

        if (!room) return;

        if (socket.id !== room.drawerId) {
            return;
        }

        io.to(room.code).emit(
            "clearBoard"
        );
    });

    // --------------------------------------------------
    // LEAVE
    // --------------------------------------------------

    socket.on("leaveRoom", () => {
        removePlayer(socket);
    });

    socket.on("disconnect", () => {

        console.log(
            "Disconnected:",
            socket.id
        );

        removePlayer(socket);
    });
});

// ======================================================
// REMOVE PLAYER
// ======================================================

function removePlayer(socket) {

    const roomCode =
        socket.data.roomCode;

    if (!roomCode) return;

    const room =
        rooms.get(roomCode);

    if (!room) return;

    const index =
        room.players.findIndex(
            player =>
                player.id === socket.id
        );

    if (index === -1) return;

    const player =
        room.players[index];

    const wasDrawer =
        player.id === room.drawerId;

    room.players.splice(
        index,
        1
    );

    socket.leave(roomCode);

    io.to(roomCode).emit(
        "systemMessage",
        {
            message:
                `${player.name} left the room.`
        }
    );

    if (wasDrawer && room.gameStarted) {
        endRound(room);
    }

    if (room.players.length === 0) {

        clearTimer(room);
        clearNextRoundTimer(room);

        rooms.delete(roomCode);

        console.log(
            `Room deleted: ${roomCode}`
        );

        return;
    }

    if (
        room.players.length < MIN_PLAYERS &&
        room.gameStarted
    ) {

        clearTimer(room);
        clearNextRoundTimer(room);

        room.gameStarted = false;
        room.drawerId = null;
        room.secretWord = null;
        room.timeLeft = 0;
        room.endingRound = false;

        io.to(roomCode).emit(
            "systemMessage",
            {
                message:
                    "Waiting for another player..."
            }
        );
    }

    broadcastRoom(room);
}

// ======================================================
// SERVER
// ======================================================

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");
        console.log(
            "=================================="
        );
        console.log(
            "          SCRIBBLIX"
        );
        console.log(
            "=================================="
        );
        console.log(
            `Running on port ${PORT}`
        );
        console.log(
            "Multiplayer server ready."
        );
        console.log(
            "=================================="
        );
        console.log("");
    }
);