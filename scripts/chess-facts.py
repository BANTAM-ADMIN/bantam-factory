"""Chess move facts for the BANTAM chess gauge. Runs inside the sealed execution
cell (scripts/exec-cell.py); the gauge sends this file as the job's code and
calls facts(fen, moves).

For each candidate move (UCI), exact facts about the position after it:
whether it mates or gives check, what it captures or promotes to, whether the
moved piece then stands on a square the opponent attacks without enough
defence, and whether it lets the opponent mate at once. No search beyond one
reply for mate: the facts guard against blunders and point at forcing moves;
choosing the move is left to the model.
"""
import chess

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
NAME = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop", chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}


def allows_mate(board):
    """Whether the side to move on `board` has a mating move."""
    for reply in board.legal_moves:
        board.push(reply)
        mate = board.is_checkmate()
        board.pop()
        if mate:
            return True
    return False


def hanging(board, square, us):
    """The moved piece is attacked, and either undefended or attacked by a
    cheaper piece (a losing exchange at first glance)."""
    piece = board.piece_at(square)
    if piece is None or piece.piece_type == chess.KING:
        return False
    attackers = board.attackers(not us, square)
    if not attackers:
        return False
    if not board.attackers(us, square):
        return True
    cheapest = min(VALUE[board.piece_type_at(a)] for a in attackers)
    return cheapest < VALUE[piece.piece_type]


def facts(fen, moves):
    board = chess.Board(fen)
    us = board.turn
    out = {}
    for uci in moves:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            out[uci] = {"legal": False}
            continue
        f = {"san": board.san(move)}
        if board.is_capture(move):
            captured = chess.PAWN if board.is_en_passant(move) else board.piece_type_at(move.to_square)
            f["captures"] = NAME[captured]
        if move.promotion:
            f["promotes"] = NAME[move.promotion]
        mover = board.piece_type_at(move.from_square)
        board.push(move)
        if board.is_checkmate():
            f["mate"] = True
        else:
            if board.is_check():
                f["check"] = True
            if board.is_stalemate():
                f["stalemate"] = True
            if hanging(board, move.to_square, us):
                f["hangs"] = NAME[mover]
            if allows_mate(board):
                f["allows_mate"] = True
        board.pop()
        out[uci] = f
    return out
