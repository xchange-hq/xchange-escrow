/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/xchange_escrow.json`.
 */
export type XchangeEscrow = {
  address: '9TwvUTeAP5q2CjkgrkUBDjqUR1PWJCvnXysSWxhnVvBZ';
  metadata: {
    name: 'xchangeEscrow';
    version: '0.1.0';
    spec: '0.1.0';
  };
  instructions: [
    {
      name: 'closeFinished';
      docs: [
        'Close one escrow that already finished but was left open: released or',
        'refunded before closing existed, or by a client that named no rent',
        'destination. Never a funded escrow, and never while its vault holds',
        'anything. Both rents go to the address the authority set with',
        '`set_rent_to`, and nowhere else. Anyone may ask, paying the network',
        'fee: nothing can move but rent, a finished escrow holds no funds, and',
        'the rent goes only where the authority said.',
      ];
      discriminator: [199, 150, 61, 66, 164, 239, 127, 189];
      accounts: [
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'vault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'escrow';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'mint';
          relations: ['escrow'];
        },
        {
          name: 'rent';
          docs: ['Where the rent goes: required here, so nothing closes without it.'];
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 110, 116];
              },
            ];
          };
        },
        {
          name: 'rentTo';
          writable: true;
        },
        {
          name: 'tokenProgram';
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
      ];
    },
    {
      name: 'deposit';
      docs: [
        'Lock `amount` of the mint for `order_id`. `counterparty` is known for',
        'a taker and null for a maker. `expiry` is a unix time after which',
        'anyone may refund.',
      ];
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182];
      accounts: [
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'vault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'escrow';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'mint';
        },
        {
          name: 'depositorToken';
          writable: true;
        },
        {
          name: 'depositor';
          signer: true;
        },
        {
          name: 'payer';
          docs: ['Whoever pays rent: the depositor, or the sponsor on their behalf.'];
          writable: true;
          signer: true;
        },
        {
          name: 'tokenProgram';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
        {
          name: 'amount';
          type: 'u64';
        },
        {
          name: 'counterparty';
          type: {
            option: 'pubkey';
          };
        },
        {
          name: 'expiry';
          type: 'i64';
        },
      ];
    },
    {
      name: 'initialize';
      docs: [
        'Once. The payer becomes the authority; it may change the coordinator',
        'and the fee, within bounds, and nothing else.',
      ];
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
      accounts: [
        {
          name: 'config';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'coordinator';
          type: 'pubkey';
        },
        {
          name: 'feeBps';
          type: 'u16';
        },
      ];
    },
    {
      name: 'refund';
      docs: [
        'Everything back to the depositor. The depositor at any time while',
        'unmatched; anyone once expired.',
      ];
      discriminator: [2, 96, 183, 251, 63, 208, 46, 46];
      accounts: [
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'vault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'escrow';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'mint';
          relations: ['escrow'];
        },
        {
          name: 'depositor';
          relations: ['escrow'];
        },
        {
          name: 'depositorToken';
          writable: true;
        },
        {
          name: 'rent';
          docs: ["Where the closed escrow's rent goes, if the authority has set one."];
          optional: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 110, 116];
              },
            ];
          };
        },
        {
          name: 'rentTo';
          writable: true;
          optional: true;
        },
        {
          name: 'caller';
          signer: true;
        },
        {
          name: 'tokenProgram';
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
      ];
    },
    {
      name: 'register';
      docs: [
        'A person registers their own address by signing. Only registered',
        'addresses can ever be set as a counterparty by the coordinator.',
      ];
      discriminator: [211, 124, 67, 15, 211, 194, 178, 240];
      accounts: [
        {
          name: 'registry';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 103, 105, 115, 116, 114, 121];
              },
              {
                kind: 'account';
                path: 'owner';
              },
            ];
          };
        },
        {
          name: 'owner';
          signer: true;
        },
        {
          name: 'payer';
          writable: true;
          signer: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [];
    },
    {
      name: 'release';
      docs: ['Pay the counterparty, less the fee into the fee vault. Coordinator only.'];
      discriminator: [253, 249, 15, 206, 28, 127, 193, 241];
      accounts: [
        {
          name: 'config';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'coordinator';
          writable: true;
          signer: true;
          relations: ['config'];
        },
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'vault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'escrow';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'mint';
          relations: ['escrow'];
        },
        {
          name: 'counterpartyToken';
          writable: true;
        },
        {
          name: 'feeVault';
          docs: ["The fee vault: the config PDA's own token account for this mint."];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'config';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'rent';
          docs: ["Where the closed escrow's rent goes, if the authority has set one."];
          optional: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 110, 116];
              },
            ];
          };
        },
        {
          name: 'rentTo';
          writable: true;
          optional: true;
        },
        {
          name: 'tokenProgram';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
      ];
    },
    {
      name: 'releasePartial';
      docs: [
        'Pay `amount` of the escrow to a registered address, less the fee, and',
        'keep the rest in escrow. This is how one offer fills several takers.',
        'The last part empties the escrow and marks it released. Coordinator',
        'only; only while funded and not expired; never to an unregistered',
        "address, which is the registry account's job to prove.",
      ];
      discriminator: [86, 57, 247, 124, 243, 51, 221, 170];
      accounts: [
        {
          name: 'config';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'coordinator';
          writable: true;
          signer: true;
          relations: ['config'];
        },
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'vault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'escrow';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'mint';
          relations: ['escrow'];
        },
        {
          name: 'registry';
          docs: ["The recipient's registration: it must exist, which is the whole point."];
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 103, 105, 115, 116, 114, 121];
              },
              {
                kind: 'account';
                path: 'registry.owner';
                account: 'registry';
              },
            ];
          };
        },
        {
          name: 'counterpartyToken';
          writable: true;
        },
        {
          name: 'feeVault';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'config';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'rent';
          docs: ["Where the closed escrow's rent goes, if the authority has set one."];
          optional: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 110, 116];
              },
            ];
          };
        },
        {
          name: 'rentTo';
          writable: true;
          optional: true;
        },
        {
          name: 'tokenProgram';
        },
        {
          name: 'associatedTokenProgram';
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
        {
          name: 'amount';
          type: 'u64';
        },
      ];
    },
    {
      name: 'setCoordinator';
      discriminator: [3, 248, 224, 239, 81, 218, 95, 214];
      accounts: [
        {
          name: 'config';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'authority';
          signer: true;
          relations: ['config'];
        },
      ];
      args: [
        {
          name: 'coordinator';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'setCounterparty';
      docs: [
        "The coordinator names a maker's counterparty, once, when a fill is",
        'journaled. Only a registered address; only while unmatched and funded.',
      ];
      discriminator: [218, 62, 204, 64, 223, 16, 92, 135];
      accounts: [
        {
          name: 'config';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'coordinator';
          signer: true;
          relations: ['config'];
        },
        {
          name: 'escrow';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: 'arg';
                path: 'orderId';
              },
            ];
          };
        },
        {
          name: 'registry';
          docs: ["The counterparty's registration: it must exist, which is the whole point."];
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 103, 105, 115, 116, 114, 121];
              },
              {
                kind: 'account';
                path: 'registry.owner';
                account: 'registry';
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'orderId';
          type: {
            array: ['u8', 16];
          };
        },
      ];
    },
    {
      name: 'setFee';
      discriminator: [18, 154, 24, 18, 237, 214, 19, 80];
      accounts: [
        {
          name: 'config';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'authority';
          signer: true;
          relations: ['config'];
        },
      ];
      args: [
        {
          name: 'feeBps';
          type: 'u16';
        },
      ];
    },
    {
      name: 'setRentTo';
      docs: [
        'Where closed escrows send their rent: the wallet that pays it. The',
        'authority only. Until this is set, escrows are left open after they',
        'empty, as they always were.',
      ];
      discriminator: [253, 132, 197, 190, 79, 48, 115, 185];
      accounts: [
        {
          name: 'config';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'authority';
          writable: true;
          signer: true;
          relations: ['config'];
        },
        {
          name: 'rent';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [114, 101, 110, 116];
              },
            ];
          };
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'to';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'withdrawFees';
      docs: [
        "Move collected fees out of a mint's fee vault to the authority's own",
        'token account for that mint. Authority only; the vault holds nothing',
        "but fees, so nobody's escrow can be touched through it.",
      ];
      discriminator: [198, 212, 171, 109, 144, 215, 174, 89];
      accounts: [
        {
          name: 'config';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: 'authority';
          writable: true;
          signer: true;
          relations: ['config'];
        },
        {
          name: 'mint';
        },
        {
          name: 'feeVault';
          docs: ["The fee vault: the config PDA's own token account for this mint."];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'account';
                path: 'config';
              },
              {
                kind: 'account';
                path: 'tokenProgram';
              },
              {
                kind: 'account';
                path: 'mint';
              },
            ];
            program: {
              kind: 'const';
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ];
            };
          };
        },
        {
          name: 'authorityToken';
          docs: [
            "The authority's own token account for this mint, opened beforehand by whoever runs this.",
          ];
          writable: true;
        },
        {
          name: 'tokenProgram';
        },
      ];
      args: [
        {
          name: 'amount';
          type: 'u64';
        },
      ];
    },
  ];
  accounts: [
    {
      name: 'config';
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130];
    },
    {
      name: 'escrow';
      discriminator: [31, 213, 123, 187, 186, 22, 218, 155];
    },
    {
      name: 'registry';
      discriminator: [47, 174, 110, 246, 184, 182, 252, 218];
    },
    {
      name: 'rentTo';
      discriminator: [177, 84, 218, 120, 190, 198, 153, 4];
    },
  ];
  errors: [
    {
      code: 6000;
      name: 'feeTooHigh';
      msg: 'The fee is above the allowed maximum';
    },
    {
      code: 6001;
      name: 'zeroAmount';
      msg: 'Nothing to deposit';
    },
    {
      code: 6002;
      name: 'expiryInPast';
      msg: 'The expiry is in the past';
    },
    {
      code: 6003;
      name: 'notFunded';
      msg: 'This escrow is not holding funds';
    },
    {
      code: 6004;
      name: 'alreadyMatched';
      msg: 'This escrow already has a counterparty';
    },
    {
      code: 6005;
      name: 'expired';
      msg: 'This escrow has expired';
    },
    {
      code: 6006;
      name: 'noCounterparty';
      msg: 'No counterparty has been set';
    },
    {
      code: 6007;
      name: 'wrongCounterparty';
      msg: 'That token account does not belong to the counterparty';
    },
    {
      code: 6008;
      name: 'notRefundable';
      msg: 'Only the depositor may refund an unmatched escrow before it expires';
    },
    {
      code: 6009;
      name: 'badAmount';
      msg: 'The amount must be more than zero and no more than the escrow holds';
    },
    {
      code: 6010;
      name: 'wrongRentDestination';
      msg: 'Rent may only go to the address the authority set';
    },
    {
      code: 6011;
      name: 'stillFunded';
      msg: 'This escrow still holds funds';
    },
    {
      code: 6012;
      name: 'vaultNotEmpty';
      msg: "This escrow's vault is not empty";
    },
  ];
  types: [
    {
      name: 'config';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'authority';
            type: 'pubkey';
          },
          {
            name: 'coordinator';
            type: 'pubkey';
          },
          {
            name: 'feeBps';
            type: 'u16';
          },
          {
            name: 'bump';
            type: 'u8';
          },
        ];
      };
    },
    {
      name: 'escrow';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'orderId';
            type: {
              array: ['u8', 16];
            };
          },
          {
            name: 'depositor';
            type: 'pubkey';
          },
          {
            name: 'mint';
            type: 'pubkey';
          },
          {
            name: 'amount';
            type: 'u64';
          },
          {
            name: 'counterparty';
            type: {
              option: 'pubkey';
            };
          },
          {
            name: 'expiry';
            type: 'i64';
          },
          {
            name: 'matched';
            type: 'bool';
          },
          {
            name: 'state';
            type: {
              defined: {
                name: 'state';
              };
            };
          },
          {
            name: 'bump';
            type: 'u8';
          },
        ];
      };
    },
    {
      name: 'registry';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'owner';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'rentTo';
      docs: ["Where a closed escrow's rent goes. One per program, set by the authority."];
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'to';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'state';
      type: {
        kind: 'enum';
        variants: [
          {
            name: 'funded';
          },
          {
            name: 'released';
          },
          {
            name: 'refunded';
          },
        ];
      };
    },
  ];
};
