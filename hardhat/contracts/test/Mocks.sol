// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Local stand-ins for the Ritual Chain system contracts and precompiles.
 *
 * The tests deploy each of these once, copy its runtime code onto the canonical
 * Ritual address with `setCode`, and then configure it. That lets the whole
 * market lifecycle — including the scheduled self-resolution and the oracle read
 * path — run end to end on a vanilla Hardhat node, where 0x56e7…, 0x0801, 0x0803,
 * etc. would otherwise be empty accounts.
 */

/// Minimal Scheduler: hands out incrementing call ids, tracks cancel state.
contract MockScheduler {
    uint256 public nextId;
    mapping(uint256 => uint8) public callState;

    function approveScheduler(address) external {}

    function schedule(
        bytes calldata,
        uint32,
        uint32,
        uint32,
        uint32,
        uint32,
        uint256,
        uint256,
        uint256,
        address
    ) external returns (uint256 callId) {
        callId = ++nextId; // 1-based so a real id is never 0
        callState[callId] = 1;
    }

    function cancel(uint256 callId) external {
        callState[callId] = 0;
    }

    function getCallState(uint256 callId) external view returns (uint8) {
        return callState[callId];
    }
}

/// TEEServiceRegistry stand-in with a settable executor / found flag.
contract MockTEERegistry {
    address public executor;
    bool public found;

    function set(address executor_, bool found_) external {
        executor = executor_;
        found = found_;
    }

    function pickServiceByCapability(
        uint8,
        bool,
        uint256,
        uint256
    ) external view returns (address, bool) {
        return (executor, found);
    }
}

/// RitualWallet stand-in: native-balance escrow keyed by depositor.
contract MockRitualWallet {
    mapping(address => uint256) public balances;

    function deposit(uint256) external payable {
        balances[msg.sender] += msg.value;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function lockUntil(address) external view returns (uint256) {
        return 0;
    }
}

/// HTTP precompile (0x0801) stand-in: returns a preset async envelope for any input.
contract MockHttp {
    bytes public envelope;

    function setEnvelope(bytes calldata e) external {
        envelope = e;
    }

    fallback() external {
        bytes memory e = envelope;
        assembly {
            return(add(e, 0x20), mload(e))
        }
    }
}

/// jq precompile (0x0803) stand-in: returns preset bytes (empty = extraction failure).
contract MockJq {
    bytes public output;

    function setOutput(bytes calldata o) external {
        output = o;
    }

    fallback() external {
        bytes memory o = output;
        assembly {
            return(add(o, 0x20), mload(o))
        }
    }
}
