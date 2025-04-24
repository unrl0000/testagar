import os
import random
import math
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

# --- Настройки ---
MAP_WIDTH = 2000
MAP_HEIGHT = 2000
INITIAL_PLAYER_SIZE = 20
FOOD_COUNT = 150
FOOD_SIZE = 8
PLAYER_SPEED_FACTOR = 8 # Чем меньше, тем быстрее
EAT_RATIO = 1.1 # Нужно быть больше в X раз, чтобы съесть

# --- Приложение Flask и SocketIO ---
app = Flask(__name__)
# Secret key важен для сессий SocketIO
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'your_very_secret_key_123!@#')
# Используем eventlet для асинхронности
socketio = SocketIO(app, async_mode='eventlet')

# --- Игровое состояние ---
players = {} # { sid: { 'id': sid, 'name': name, 'x': x, 'y': y, 'size': size, 'color': color, 'target_x': x, 'target_y': y } }
food = []

# --- Вспомогательные функции ---
def get_random_color():
    return f'hsl({random.randint(0, 360)}, 70%, 50%)'

def generate_food():
    """Генерирует начальную еду и пополняет ее"""
    needed = FOOD_COUNT - len(food)
    for _ in range(needed):
        food.append({
            'id': random.randint(10000, 99999), # Простой ID для еды
            'x': random.uniform(FOOD_SIZE, MAP_WIDTH - FOOD_SIZE),
            'y': random.uniform(FOOD_SIZE, MAP_HEIGHT - FOOD_SIZE),
            'size': FOOD_SIZE,
            'color': get_random_color()
        })

def get_player_by_id(player_id):
     return players.get(player_id)

def get_distance(obj1, obj2):
    dx = obj1['x'] - obj2['x']
    dy = obj1['y'] - obj2['y']
    return math.sqrt(dx*dx + dy*dy)

# --- Инициализация игры ---
generate_food()

# --- Маршруты Flask ---
@app.route('/')
def index():
    """Отдаем главную HTML страницу"""
    return render_template('index.html')

# --- События SocketIO ---
@socketio.on('connect')
def handle_connect():
    """Клиент подключился"""
    print(f'Client connected: {request.sid}')
    # Пока ничего не делаем, ждем 'join'

@socketio.on('disconnect')
def handle_disconnect():
    """Клиент отключился"""
    print(f'Client disconnected: {request.sid}')
    player = players.pop(request.sid, None) # Удаляем игрока из словаря
    if player:
        # Оповещаем всех остальных, что игрок ушел
        socketio.emit('player_left', {'id': request.sid}, broadcast=True)

@socketio.on('join')
def handle_join(data):
    """Игрок входит в игру"""
    sid = request.sid
    name = data.get('name', 'Blob')[:15] # Ограничим длину ника
    print(f'Player {name} ({sid}) joining.')

    # Создаем нового игрока
    player = {
        'id': sid,
        'name': name,
        'x': random.uniform(INITIAL_PLAYER_SIZE, MAP_WIDTH - INITIAL_PLAYER_SIZE),
        'y': random.uniform(INITIAL_PLAYER_SIZE, MAP_HEIGHT - INITIAL_PLAYER_SIZE),
        'size': INITIAL_PLAYER_SIZE,
        'color': get_random_color(),
        'target_x': 0, # Куда движется относительно центра экрана
        'target_y': 0
    }
    players[sid] = player

    # 1. Отправляем новому игроку его ID и размер карты
    emit('game_setup', {'playerId': sid, 'mapWidth': MAP_WIDTH, 'mapHeight': MAP_HEIGHT})

    # 2. Отправляем новому игроку текущее состояние ВСЕХ игроков и еды
    emit('current_state', {'players': list(players.values()), 'food': food})

    # 3. Оповещаем ВСЕХ ОСТАЛЬНЫХ о новом игроке
    socketio.emit('player_joined', player, broadcast=True, include_self=False)


@socketio.on('player_move')
def handle_player_move(data):
    """Получаем направление движения от клиента"""
    player = get_player_by_id(request.sid)
    if player:
        # data['x'], data['y'] - координаты мыши относительно центра экрана
        player['target_x'] = data.get('x', 0)
        player['target_y'] = data.get('y', 0)

# --- Игровой цикл (запускается в фоне) ---
def game_loop():
    """Основной цикл обновления состояния игры"""
    while True:
        food_eaten_indices = set()
        players_to_remove = set()
        updated_players = [] # Собираем изменения для отправки

        # 1. Движение и границы карты
        for sid, player in players.items():
            target_x = player['target_x']
            target_y = player['target_y']
            distance_to_target = math.sqrt(target_x**2 + target_y**2)

            # Нормализуем вектор направления, если он не нулевой
            if distance_to_target > 1:
                direction_x = target_x / distance_to_target
                direction_y = target_y / distance_to_target
            else:
                direction_x = 0
                direction_y = 0

            # Скорость зависит от размера (чем больше, тем медленнее)
            speed = PLAYER_SPEED_FACTOR / (1 + math.log1p(player['size'] / INITIAL_PLAYER_SIZE)) # Плавное замедление

            new_x = player['x'] + direction_x * speed
            new_y = player['y'] + direction_y * speed

            # Ограничение по карте
            player['x'] = max(player['size'] / 2, min(MAP_WIDTH - player['size'] / 2, new_x))
            player['y'] = max(player['size'] / 2, min(MAP_HEIGHT - player['size'] / 2, new_y))

        # 2. Поедание еды
        for sid, player in players.items():
            if sid in players_to_remove: continue # Пропускаем уже съеденных

            player_radius = player['size'] / 2
            for i, f in enumerate(food):
                if i in food_eaten_indices: continue

                dist = get_distance(player, f)
                if dist < player_radius - f['size'] / 3: # Небольшое перекрытие для поедания
                    player['size'] += f['size'] * 0.2 # Еда дает меньше прироста, чем игроки
                    food_eaten_indices.add(i)
                    # Можно добавить логику оповещения о съеденной еде или просто обновить всю еду

        # 3. Поедание игроков
        player_ids = list(players.keys())
        for i in range(len(player_ids)):
            sid_a = player_ids[i]
            if sid_a in players_to_remove: continue
            player_a = players[sid_a]

            for j in range(i + 1, len(player_ids)):
                sid_b = player_ids[j]
                if sid_b in players_to_remove: continue
                player_b = players[sid_b]

                dist = get_distance(player_a, player_b)
                radius_a = player_a['size'] / 2
                radius_b = player_b['size'] / 2

                # Проверяем, может ли кто-то кого-то съесть
                if dist < radius_a - radius_b * 0.8 and player_a['size'] > player_b['size'] * EAT_RATIO:
                    # A ест B
                    player_a['size'] += player_b['size'] # Прирост равен размеру съеденного
                    players_to_remove.add(sid_b)
                    print(f"{player_a['name']} ate {player_b['name']}")
                elif dist < radius_b - radius_a * 0.8 and player_b['size'] > player_a['size'] * EAT_RATIO:
                    # B ест A
                    player_b['size'] += player_a['size']
                    players_to_remove.add(sid_a)
                    print(f"{player_b['name']} ate {player_a['name']}")
                    break # Игрока A съели, нет смысла проверять его дальше в этом цикле

        # 4. Удаление съеденных игроков
        if players_to_remove:
            for sid in players_to_remove:
                eaten_player = players.pop(sid, None)
                if eaten_player:
                    socketio.emit('player_eaten', {'eaten_id': sid, 'eater_id': None}, broadcast=True) # TODO: Определять кто съел для обновления счета
                    # Можно отправить 'game_over' конкретному съеденному игроку
                    socketio.emit('game_over', {'message': 'You were eaten!'}, room=sid)


        # 5. Удаление съеденной еды и генерация новой
        if food_eaten_indices:
            food[:] = [f for i, f in enumerate(food) if i not in food_eaten_indices]
            generate_food() # Добавляем новую еду взамен съеденной

        # 6. Отправка обновленного состояния всем клиентам
        current_players_list = list(players.values())
        socketio.emit('game_update', {
            'players': current_players_list,
            'food': food # Отправляем всю еду (проще для начала)
        })

        # Пауза перед следующей итерацией (контроль FPS сервера)
        socketio.sleep(1 / 30) # ~30 обновлений в секунду

# Запускаем игровой цикл в фоновом потоке
socketio.start_background_task(game_loop)

# --- Запуск сервера ---
if __name__ == '__main__':
    print("Starting server...")
    # Используем socketio.run для правильного запуска с eventlet/gevent
    # host='0.0.0.0' - слушать на всех интерфейсах (важно для Docker/Render)
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
    # debug=True полезно для локальной разработки, но НЕ для продакшена
