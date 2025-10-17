const { col, Op, literal, where: whereSql } = require("sequelize");
const {
  loan: Loan,
  loanRequests: LoanRequest,
  users: User,
  loanTokenOwner: LoanTokenOwner,
  collection: Collection,
  token: Token,
  wallets: EthWallets,
  subscribers: Subscriber,
} = require("../models");
const twitterService = require('../api/twitter');

const requiredFieldsInRelation = require("../utils/getRelationFields");
const moment = require("moment");
const { sendTemplate, from } = require("../utils/helpers");
const { AWS_uploadFile } = require("../aws/s3");
const {
  getObligationOwner,
  getPromissoryOwner,
  getPromissoryContractNFTsByWallet,
} = require("../api/simplehash");
const {
  jobUnpaidLoan,
  reminderNotifications,
} = require("../jobs/loans");
const { generateReceiptImage } = require("../api/generateReceiptImage");
const {
  generateAttrbiutesForNettyScore,
  genrateNettyScoreRelation,
  getPaidCount,
  getForeclosedCount,
  getActiveCount,
  getAmountJsonBasedOnStatus,
  getCountBasedOfStatus,
} = require("../utils/nettyscore");
const { setFloorPrices } = require("../utils/setFloorPrices");
const { generateAssetName } = require("../utils/generateAssetName");
const { borrowedLoansRepository } = require("../repositories/loanRepository");
const { sendNotification } = require("../api/sendNotification");
const { refreshNFTMetadata } = require("../api/opensea");
const { addPoints, detectPoints } = require("../repositories/pointsRepository");
const { getConversion } = require("../api/api");
const { useCalculateLtv } = require("../utils/calculateLtv");

const formatCalendarDate = (date) => date.format("YYYYMMDDTHHmmss") + "Z";

const acceptCounterOffer = async ({
  loanRequest,
  emailPayload,
  borrower,
  assetName,
  frontUrl,
}) => {
  const lender = await User.findOne({
    where: {
      id: loanRequest.userId,
    },
    include: [
      {
        model: Subscriber,
      },
    ],
    attributes: ["name", "email", "id"],
  });

  sendTemplate(
    from,
    lender.email,
    `🤝Your offer on ${assetName} has been accepted!`,
    "../views/loans/loan-offer/accept/lender/index.ejs",
    {
      ...emailPayload,
      username: lender.name,
    }
  );

  sendNotification(
    {
      subscribers: borrower.subscribers,
      userId: borrower.id,
    },
    {
      title: "🤝Counter offer accepted!",
      description: `🤝Counter offer accepted! Funds transferred, and ${assetName} is in escrow.`,
      url: frontUrl,
    }
  );

  sendNotification(
    {
      subscribers: lender.subscribers,
      userId: lender.id,
    },
    {
      title: "🤝 Your counter offer has been accepted!",
      description: `Funds transferred, and ${assetName} is in escrow.`,
      url: frontUrl,
    }
  );
};

exports.acceptLoanRequestRepo = async ({
  requestId,
  loanChainId,
  transaction,
  tokenId,
  borrowerAddress,
  lenderReceiptId,
  borrowerReceiptId,
  lenderAddress,
  collectionMarketplaceId,
  userId,
  image,
  collectionAddress,
}) => {
  if (borrowerAddress) {
    const request = await LoanRequest.findOne({
      where: {
        id: requestId,
      },
      include: {
        model: Collection,
      },
      attributes: ["collectionId"],
    });

    await LoanTokenOwner.findOrCreate({
      where: {
        tokenId,
        collectionId: collectionMarketplaceId,
      },
      defaults: {
        tokenId,
        collectionAddress: request.collectionId,
        collectionName: request.collection.name,
        userId,
        ownerAddress: borrowerAddress,
        collectionId: collectionMarketplaceId,
        image,
      },
    });

    await LoanRequest.update(
      {
        tokenId,
        collectionAddress,
      },
      {
        where: {
          id: requestId,
        },
      }
    );
  }

  if (!borrowerAddress) {
    const {
      owners: [oblBorrower],
    } = await getObligationOwner({ tokenId: borrowerReceiptId });
    borrowerAddress = oblBorrower?.ownerAddress;
  }

  if (!lenderAddress) {
    const {
      owners: [promLender],
    } = await getPromissoryOwner({ tokenId: lenderReceiptId });
    lenderAddress = promLender?.ownerAddress;
  }

  const loanRequestsToDelete = await LoanRequest.findAll({
    where: {
      tokenId,
      id: { [Op.ne]: requestId },
    },
    include: [
      {
        model: Loan,
        as: "activeToken",
        attributes: ["id"],
        required: false,
        where: {
          [Op.or]: [
            { status: "active" },
            { loanRequestId: { [Op.col]: "loanRequest.id" } },
          ],
        },
      },
    ],
    attributes: ["id"],
    having: literal("`activeToken.id` IS NULL"),
    raw: true,
  });

  const loanRequest = await LoanRequest.findOne({
    where: { id: requestId },
    raw: true,
    attributes: {
      include: [
        [col("token.symbol"), "currencySymbol"],
        [col("loanTokenOwner.userId"), "borrowerUserId"],
      ],
    },
    include: [
      {
        model: Token,
        attributes: [],
      },
      {
        model: LoanTokenOwner,
        attributes: [],
        required: false,
      },
    ],
  });

  const {
    userId: lenderUserId,
    lenderAddress: offerLenderAddress,
    principal,
    repay,
    apr,
    term,
    collectionId,
    collectionName,
    borrowerUserId,
    currencySymbol: currency,
  } = loanRequest;

  const tokenOwner = await LoanTokenOwner.findOne({
    where: {
      tokenId,
      collectionAddress,
    },
  });

  const isCounterOrCollectionOffer = !!offerLenderAddress;
  const isCollectionOffer = !!collectionId;

  const idsToDelete = loanRequestsToDelete.map((lr) => lr.id);

  if (idsToDelete.length > 0) {
    await LoanRequest.destroy({
      where: {
        id: { [Op.in]: idsToDelete },
      },
    });
  }

  const correctLenderUserId = isCounterOrCollectionOffer
    ? lenderUserId
    : userId;
  const correctBorrowerUserId = isCounterOrCollectionOffer
    ? userId
    : borrowerUserId;

  const lender = await User.findOne({
    where: {
      id: correctLenderUserId,
    },
    include: [
      {
        model: Subscriber,
      },
    ],
    attributes: ["email", "name", "id"],
  });

  const endDate = moment().add(loanRequest.termUnix, "s");

  const { data: conversions } = await getConversion({
    convert: "USD",
    symbol: currency,
  });

  const usdPrice = conversions[0].quote.USD.price;

  const { id, createdAt: loanCreatedAt } = await Loan.create({
    loanRequestId: requestId,
    loanChainId,
    transaction,
    lenderUserId: correctLenderUserId,
    borrowerUserId: correctBorrowerUserId,
    tokenId,
    collectionAddress: tokenOwner.collectionAddress,
    NWPN: lenderReceiptId,
    NWOR: borrowerReceiptId,
    endDate: endDate.toDate(),
    lenderAddress,
    borrowerAddress,
    usdPrice,
  });

  await twitterService.postLoanInitiated({
    borrower: borrower.name,
    loanAmount: principal,
    crypto: currency,
    nftName: tokenOwner.name || generateAssetName({ collectionName: tokenOwner.collectionName, tokenId }), // Используйте name или сгенерируйте
    collectionName: tokenOwner.collectionName,
    apr,
    loanDuration: `${term} дней`,
    nftImageUrl: tokenOwner.image,
  }).catch(error => {
    console.error('Ошибка публикации в Twitter (postLoanInitiated):', error);
  });

  const frontUrl = "/loans/" + id + "/active";
  const baseEmailPayload = {
    collection: tokenOwner.collectionName,
    assetName: tokenOwner.tokenId,
    image: tokenOwner.image,
    buttonLink: process.env.NETTY_URL + frontUrl,
    tokenSymbol: currency,
    loanId: lenderReceiptId,
  };

  const emailPayload = {
    ...baseEmailPayload,
    term: loanRequest.term,
    repay: loanRequest.repay,
    loanAmount: loanRequest.principal,
  };

  const borrower = await User.findOne({
    where: {
      id: tokenOwner.userId,
    },
    attributes: ["name", "email", "id"],
    include: [
      {
        model: Subscriber,
      },
    ],
  });

  const assetName = generateAssetName({
    collectionName: tokenOwner.collectionName,
    tokenId: tokenOwner.tokenId,
  });
  if (!isCollectionOffer) {
    // send email to borrower
    sendTemplate(
      from,
      borrower.email,
      `🕒 Your Loan ${id} Has Started!`,
      "../views/loans/loan-offer/accept/borrower/index.ejs",
      {
        ...emailPayload,
        username: borrower.name,
        startDate: formatCalendarDate(moment.utc()),
        endDate: formatCalendarDate(endDate),
        tokenSymbol: currency,
      }
    );

    if (isCounterOrCollectionOffer) {
      acceptCounterOffer({
        loanRequest,
        emailPayload,
        borrower,
        assetName,
        frontUrl,
      });
    } else {
      sendTemplate(
        from,
        lender.email,
        `🤝 Loan Successfully Funded for ${assetName}`,
        "../views/loans/loan-request/accept/index.ejs",
        {
          ...emailPayload,
          username: lender.name,
          borrowerUsername: borrower.name,
          tokenSymbol: currency,
        }
      );

      sendNotification(
        {
          subscribers: borrower.subscribers,
          userId: borrower.id,
        },
        {
          title: "🤝 Loan offer accepted!",
          description: `🤝 Loan offer accepted! Funds transferred, and ${assetName} is in escrow.`,
          url: "/loans/" + id + "/active",
        }
      );
    }
  } else {
    // send email to borrower
    sendTemplate(
      from,
      borrower.email,
      `💥 Offer Accepted – Your Loan ${assetName} is Now Live!`,
      "../views/loans/collection-offer/accept/borrower/index.ejs",
      {
        ...emailPayload,
        username: borrower.name,
      }
    );

    // send email to lender
    sendTemplate(
      from,
      lender.email,
      `🎉 Collection Offer Accepted on ${collectionName}!!`,
      "../views/loans/collection-offer/accept/lender/index.ejs",
      {
        ...emailPayload,
        username: lender.name,
      }
    );

    sendNotification(
      {
        subscribers: borrower.subscribers,
        userId: borrower.id,
      },
      {
        title: "Accepted collection offer",
        description: `🎉 You accepted a collection offer on ${assetName}. Loan is now active.`,
        url: frontUrl,
      }
    );

    sendNotification(
      {
        subscribers: lender.subscribers,
        userId: lender.id,
      },
      {
        title: "Accepted collection offer",
        description: `🎉 Your collection offer on ${assetName} was accepted! Loan is now active.`,
        url: frontUrl,
      }
    );
  }

  const bucket = "lending-protocol";

  const formatDateReceiptDate = (date) =>
    moment(date).format("DD/MM/YYYY HH:mm:ss");

  const recieptData = {
    external_url: `https://lending.nettyworth.io/loans/${id}/active`,
    attributes: [
      {
        trait_type: "Amount Borrowed",
        value: `${principal} ${currency}`,
      },
      {
        trait_type: "Amount Repaid",
        value: `${repay} ${currency}`,
      },
      {
        trait_type: "APR",
        value: `${apr}%`,
      },
      {
        display_type: "date",
        trait_type: "Date Initiated",
        value: formatDateReceiptDate(loanCreatedAt),
      },
      {
        display_type: "date",
        trait_type: "Date of Repayment",
        value: formatDateReceiptDate(endDate),
      },
      {
        trait_type: "Duration",
        value: `${term} days`,
      },
      {
        trait_type: "Loan Contract Address",
        value: process.env.NETTYWORTH_PROXY_ADDRESS,
      },
      {
        trait_type: "Loan Contract Name",
        value: "NettyWorth Loan Contract",
      },
      {
        trait_type: "Loan Contract Version",
        value: "1",
      },
      {
        trait_type: "Loan ID",
        value: loanChainId,
      },
      {
        trait_type: "Collateral Contract Address",
        value: tokenOwner.collectionAddress,
      },
      {
        trait_type: "Collateral Token ID",
        value: tokenId.toString(),
      },
    ],
  };

  const receiptImageData = {
    collectionName: tokenOwner.collectionName,
    tokenId,
    principal,
    repay: Number(repay).toFixed(4),
    apr,
    term,
    startDate: moment(loanCreatedAt).format("DD/MM/YYYY"),
    endDate: endDate.format("DD/MM/YYYY"),
    image: tokenOwner.image,
    currency,
  };

  if (process.env.NODE_ENV !== "development") {
    (async () => {
      const promissoryImage = await generateReceiptImage({
        receiptType: "promissory",
        receiptId: lenderReceiptId,
        receiptData: receiptImageData,
      });

      const obligationImage = await generateReceiptImage({
        receiptType: "obligation",
        receiptId: borrowerReceiptId,
        receiptData: receiptImageData,
      });

      const promissoryReceipt = {
        name: `NettyWorth Promissory Note #${lenderReceiptId}`,
        description:
          "This promissory note, issued by https://nettyworth.io, entitles the holder to either the repayment of principal plus interest or, if the borrower fails to repay on time, ownership of the NFT collateral securing the loan.",
        image: promissoryImage.imageUrl,
        ...recieptData,
      };

      const obligationRecieptData = {
        name: `NettyWorth Obligation Receipt #${borrowerReceiptId}`,
        description:
          "This obligation receipt, issued by https://nettyworth.io, grants the holder the right to the underlying NFT collateral of this loan upon timely repayment by the borrower.",
        image: obligationImage.imageUrl,
        ...recieptData,
      };

      await AWS_uploadFile({
        originalname: `obligation-receipt/${borrowerReceiptId}`,
        mimetype: "application/json",
        body: JSON.stringify(obligationRecieptData),
        bucket,
      });

      await AWS_uploadFile({
        originalname: `promissory-note/${lenderReceiptId}`,
        mimetype: "application/json",
        body: JSON.stringify(promissoryReceipt),
        bucket,
      });

      refreshNFTMetadata({
        tokenId: borrowerReceiptId,
        contractAddress: process.env.OBLIGATION_RECEIPT,
      });

      refreshNFTMetadata({
        tokenId: lenderReceiptId,
        contractAddress: process.env.PROMISSORY_NOTE,
      });

      await sendTemplate(
        from,
        borrower.email,
        `🎉 Your Loan ${assetName} Obligation Receipt is Ready!`,
        "../views/loans/lending-receipts/email/borrower/index.ejs",
        {
          ...baseEmailPayload,
          username: borrower.name,
          walletAddress: borrowerAddress,
        }
      );

      await sendTemplate(
        from,
        lender.email,
        `💼 Your Promissory Note for Loan #${lenderReceiptId} is Ready!`,
        "../views/loans/lending-receipts/email/borrower/index.ejs",
        {
          ...baseEmailPayload,
          username: lender.name,
          walletAddress: lenderAddress,
        }
      );

      sendNotification(
        {
          subscribers: borrower.subscribers,
          userId: borrower.id,
        },
        {
          title: "Obligation Receipt",
          description: `🎉 Obligation Receipt for ${assetName} is now in your wallet.`,
        }
      );

      sendNotification(
        {
          subscribers: lender.subscribers,
          userId: lender.id,
        },
        {
          title: "Promissory Note",
          description: `🎉 Promissory Note NFT for ${assetName} is now in your wallet.`,
        }
      );
    })();
  }

  const jobsBasePayload = {
    borrowerEmail: borrower.email,
    borrowerName: borrower.name,
    collectionName: tokenOwner.collectionName,
    tokenId,
    image: tokenOwner.image,
    loanId: lenderReceiptId,
    endDate,
    loanDbId: id,
    principal,
    repay,
    tokenSymbol: currency,
  };

  const principalInUSD = principal * usdPrice;

  const points = await detectPoints({
    usdPrincipal: principalInUSD,
  });

  if (points) {
    await addPoints({
      points,
      pointType: "borrow",
      userId: borrower.id,
      walletAddress: borrowerAddress,
    });

    await addPoints({
      points,
      pointType: "lending",
      userId: lender.id,
      walletAddress: lenderAddress,
    });
  }

  reminderNotifications({
    ...jobsBasePayload,
    loanAmount: principal,
    borrowerSubscribers: borrower.subscribers,
    borrowerId: borrower.id,
  });

  jobUnpaidLoan({
    ...jobsBasePayload,
    lenderEmail: lender.email,
    lenderName: lender.name,
    isCollectionOffer,
    lenderSubscribers: lender.subscribers,
    lenderId: lender.id,
    loanDbId: id,
  });

};

exports.acceptLoanRequest = async (req, res) => {
  try {
    const {
      requestId,
      loanChainId,
      transaction,
      tokenId,
      borrowerAddress,
      lenderReceiptId,
      borrowerReceiptId,
      lenderAddress,
      collectionMarketplaceId,
      image,
      collectionAddress,
    } = req.body;

    if (!collectionAddress) {
      return res
        .status(409)
        .send({ message: "collectionAddress is required" });
    }

    if (borrowerAddress) {
      if (!collectionMarketplaceId) {
        return res
          .status(409)
          .send({ message: "collectionMarketplaceId is required" });
      }
    }

    await this.acceptLoanRequestRepo({
      requestId,
      loanChainId,
      transaction,
      tokenId,
      borrowerAddress,
      lenderReceiptId,
      borrowerReceiptId,
      lenderAddress,
      collectionMarketplaceId,
      userId: req.userId,
      image,
      collectionAddress,
    });

    return res.status(200).send({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(400).send(e);
  }
};

exports.getActiveLoans = async (req, res) => {
  try {
    const { sort, dir, searchTerm, currency } = req.query;

    const fieldsInLoan = requiredFieldsInRelation("loanRequest", [
      "apr",
      "principal",
      "repay",
      "term",
      "tokenId",
      "termUnix",
    ]);

    const fieldsInOwner = requiredFieldsInRelation(
      "loanRequest.loanTokenOwner",
      ["collectionName", "image", "collectionAddress", "collectionId"]
    );

    const fieldsInCollection = requiredFieldsInRelation(
      "loanRequest.loanTokenOwner.collectionToken",
      ["floorPrice", "address"]
    );

    const token = requiredFieldsInRelation("loanRequest.token", [
      "symbol",
      "address",
    ]);

    const where = {
      status: "active",
      endDate: {
        [Op.gt]: new Date(),
      },
    };

    if (searchTerm) {
      where["$loanRequest.loanTokenOwner.collectionName$"] = {
        [Op.like]: `${searchTerm}%`,
      };
    }

    if (currency) {
      where["$loanRequest.currency$"] = currency;
    }

    const loans = await Loan.findAll({
      attributes: [
        "id",
        "endDate",
        ...fieldsInLoan,
        ...fieldsInOwner,
        ...token,
        ...fieldsInCollection,
      ],
      where,
      include: [
        {
          model: LoanRequest,
          attributes: [],
          required: true,
          include: [
            {
              model: LoanTokenOwner,
              attributes: [],
              on: {
                tokenId: whereSql(col("loanRequest.tokenId"), "=", col("loanRequest.loanTokenOwner.tokenId")),
                collectionAddress: whereSql(col("loanRequest.collectionAddress"), "=", col("loanRequest.loanTokenOwner.collectionAddress")),
              },
              include: [
                {
                  model: Collection,
                  as: "collectionToken",
                  attributes: [],
                },
              ],
            },
            {
              model: Token,
              attributes: [],
            },
          ],
        },
      ],
      ...(sort && dir && { order: [[col(`loanRequest.${sort}`), dir]] }),
      raw: true,
    });

    await setFloorPrices(loans, "collectionAddress", async (loan) => {
      await Collection.update(
        { floorPrice: loan.floorPrice },
        {
          where: {
            address: loan.collectionAddress,
          },
        }
      );
    });

    return res.status(200).send(loans);
  } catch (e) {
    console.error(e);
    return res.status(400).send(e);
  }
};

const getFieldsInUser = (prefix = "") => [
  "name",
  "profile_picture",
  "id",
  generateAttrbiutesForNettyScore(prefix),
];

const generateBorrowerRelationsAndAttributes = (
  prefix = "",
  usdPriceCol = "loan.usdPrice"
) => ({
  attributes: [
    ...getFieldsInUser(prefix),
    getAmountJsonBasedOnStatus(
      prefix,
      ["active", "not-active"],
      "loanBorrower",
      "borrowedAmount",
      "principal",
      usdPriceCol
    ),
    getAmountJsonBasedOnStatus(
      prefix,
      "paid",
      "loanBorrower",
      undefined,
      "repay",
      usdPriceCol
    ),
    getPaidCount(prefix),
    getForeclosedCount(prefix),
    getActiveCount(prefix),
  ],
  include: [
    ...genrateNettyScoreRelation(true, {
      include: [
        {
          model: LoanRequest,
          attributes: [],
          required: true,
          include: [
            {
              model: Token,
            },
          ],
        },
      ],
      withoutStatusChecking: true,
    }),
  ],
});

const generateLenderAttrbiutesAndRelations = (
  prefix = "",
  usdPriceCol = "loan.usdPrice"
) => ({
  attributes: [
    ...getFieldsInUser(prefix),
    getAmountJsonBasedOnStatus(
      prefix,
      ["active", "not-active"],
      "lender",
      "lentAmount",
      "principal",
      usdPriceCol
    ),
    getAmountJsonBasedOnStatus(
      prefix,
      ["paid"],
      "lender",
      "earnedAmount",
      "interestRate",
      usdPriceCol
    ),
    getCountBasedOfStatus(
      prefix,
      ["active", "not-active"],
      "loansGiven",
      "lender"
    ),
    getCountBasedOfStatus(prefix, ["active"], "activeLoans", "lender"),
  ],
  include: [
    ...genrateNettyScoreRelation(true, {
      withoutStatusChecking: true,
    }),
    {
      model: Loan,
      as: "lender",
      attributes: [],
      include: [
        {
          model: LoanRequest,
          attributes: [],
          include: [
            {
              model: Token,
            },
          ],
        },
      ],
    },
  ],
});

exports.findOne = async (req, res) => {
  const { id } = req.params;

  try {
    const fieldsInLoanRequest = [
      "apr",
      "principal",
      "repay",
      "term",
      "tokenId",
      "termUnix",
      "interestRate",
      "currency",
    ];

    const fieldsInOwner = [
      "collectionName",
      "image",
      "collectionAddress",
      "ownerAddress",
      "userId",
      "collectionId",
      "name",
    ];

    const loans = await Loan.findOne({
      attributes: [
        "id",
        "loanChainId",
        "lenderAddress",
        "borrowerAddress",
        "status",
        "NWOR",
        "NWPN",
        "endDate",
        "lenderUserId",
        ["createdAt", "acceptedAt"],
        // ["loanBorrower", "borrower"],
      ],
      where: {
        id,
        status: {
          [Op.not]: "not-active",
        },
      },
      include: [
        {
          model: LoanRequest,
          attributes: fieldsInLoanRequest,
          include: [
            {
              model: LoanTokenOwner,
              attributes: fieldsInOwner,
              raw: false,
              include: [
                {
                  model: Collection,
                  as: "collectionToken",
                  attributes: ["slug"],
                },
              ],
            },
            {
              model: Token,
            },
          ],
        },
        {
          model: User,
          required: false,
          where: {
            "$loan.status$": {
              [Op.ne]: "active",
            },
          },
          as: "loanBorrower",
          ...generateBorrowerRelationsAndAttributes("loanBorrower"),
        },
        {
          model: User,
          required: false,
          where: {
            "$loan.status$": {
              [Op.ne]: "active",
            },
          },
          as: "lender",
          ...generateLenderAttrbiutesAndRelations("lender"),
        },
      ],
    });

    const loanTokenOwnerDataValues =
      loans.dataValues.loanRequest.dataValues.loanTokenOwner.dataValues;
    const ownerUserId = loanTokenOwnerDataValues.userId;

    if (loans.status === "active") {
      const {
        owners: [owner],
      } = await getObligationOwner({ tokenId: loans.NWOR });

      const {
        owners: [lenderDetails],
      } = await getPromissoryOwner({ tokenId: loans.NWPN });

      if (owner) {
        const { ownerAddress } = owner;

        // check if db owner is the same as really owner
        if (
          loanTokenOwnerDataValues.ownerAddress.toLowerCase() ===
          ownerAddress.toLowerCase()
        ) {
          if (ownerUserId) {
            const borrower = await User.findOne({
              where: {
                id: ownerUserId,
              },
              include: [
                {
                  model: Loan,
                  as: "loanBorrower",
                },
              ],
              ...generateBorrowerRelationsAndAttributes(
                "",
                "loanBorrower.usdPrice"
              ),
            });

            loanTokenOwnerDataValues.borrower = borrower;
          }
        } else {
          loanTokenOwnerDataValues.ownerAddress = ownerAddress;

          // get really owner profile
          const wallet = await EthWallets.findOne({
            attributes: [],
            where: {
              address: ownerAddress,
            },
            include: [
              {
                model: User,
                required: true,
                include: [
                  {
                    model: Loan,
                    as: "loanBorrower",
                  },
                ],
                ...generateBorrowerRelationsAndAttributes(
                  "user",
                  "user.loanBorrower.usdPrice"
                ),
              },
            ],
          });

          // if really owner wallet exists in db
          if (wallet && wallet.user && wallet.user.id === ownerUserId) {
            loanTokenOwnerDataValues.borrower = wallet.user;
          }
        }
      }

      if (lenderDetails) {
        const { ownerAddress: lenderAddress } = lenderDetails;
        const lenderUserId = loans.dataValues.lenderUserId;

        if (
          lenderAddress.toLowerCase() ===
          loans.dataValues.lenderAddress.toLowerCase()
        ) {
          const lender = await User.findOne({
            where: {
              id: lenderUserId,
            },
            include: [
              {
                model: Loan,
                as: "lender",
              },
            ],
            ...generateLenderAttrbiutesAndRelations("", "lender.usdPrice"),
          });

          loans.dataValues.lender = lender;
        } else {
          loans.dataValues.lenderAddress = lenderAddress;

          const wallet = await EthWallets.findOne({
            attributes: [],
            where: {
              address: lenderAddress,
            },
            include: [
              {
                model: User,
                required: true,
                include: [
                  {
                    model: Loan,
                    as: "lender",
                  },
                ],
                ...generateLenderAttrbiutesAndRelations(
                  "user",
                  "user.lender.usdPrice"
                ),
              },
            ],
          });

          if (wallet && wallet.user && wallet.user.id === lenderUserId) {
            loans.dataValues.lender = wallet.user;
          }
        }
      }
    } else {
      loanTokenOwnerDataValues.borrower = loans.loanBorrower;
      delete loans.dataValues.loanBorrower;
    }

    if (loans.loanRequest.loanTokenOwner.dataValues.borrower) {
      loans.loanRequest.loanTokenOwner.dataValues.borrower.dataValues.nettyScore =
        null;
    }
    return res.status(200).send(loans);
  } catch (e) {
    console.error(e);
    return res.status(400).send(e);
  }
};

exports.updateLoanMemberAddress = async (req, res) => {
  const {
    params: { id },
    query: { address },
  } = req;

  const { NWOR, NWPN } = await Loan.findOne({
    where: { id },
    attributes: ["NWOR", "NWPN"],
    raw: true,
  });

  const updatePayload = {};
  let ownerAddress;
  if (address === "lenderAddress") {
    const {
      owners: [owner],
    } = await getPromissoryOwner({ tokenId: NWPN });
    ownerAddress = owner.ownerAddress;

    if (owner) {
      updatePayload.lenderAddress = ownerAddress;
    }
  } else if (address === "borrowerAddress") {
    const {
      owners: [owner],
    } = await getObligationOwner({ tokenId: NWOR });

    if (owner) {
      ownerAddress = owner.ownerAddress;
      updatePayload.borrowerAddress = ownerAddress;
    }
  }

  await Loan.update(updatePayload, {
    where: { id },
  });

  return res.status(200).send({ address: ownerAddress });
};

exports.myLoansStatistics = async (req, res) => {
  const {
    userId,
    query: { address },
  } = req;

  const borrowedLoans = await borrowedLoansRepository({ address, userId });

  const lentLoans = await this.lentLoans({
    query: {
      address,
    },
    userId,
  });

  const { borrowedAmountInUsd, interestPaidAmountInUsd, ...borrowedStats } =
    borrowedLoans.reduce(
      (agg, loan) => {
        let { repaidCount, activeCount, foreclosedCount } = agg;

        if (loan.status === "paid") {
          repaidCount++;
        } else if (loan.status === "active") {
          if (moment(loan.endDate).isAfter(moment())) {
            activeCount++;
          } else {
            foreclosedCount++;
          }
        } else if (loan.status === "foreclosed") {
          foreclosedCount++;
        }

        return {
          borrowedAmountInUsd:
            agg.borrowedAmountInUsd +
            loan.usdPrice * loan.loanRequest.principal,
          interestPaidAmountInUsd:
            agg.interestPaidAmountInUsd +
            loan.usdPrice * loan.loanRequest.interestRate,
          repaidCount,
          activeCount,
          foreclosedCount,
        };
      },
      {
        borrowedAmountInUsd: 0,
        interestPaidAmountInUsd: 0,
        repaidCount: 0,
        activeCount: 0,
        foreclosedCount: 0,
      }
    );

  const calculateLtv = await useCalculateLtv();
  const {
    lentAmountInUsd: lent,
    earnedAmountInUsd,
    activeCount: activeLentCount,
    foreclosedCount: foreclosedLentCount,
    repaidCount: repaidLentCount,
    ltvAmount: ltvAmountLent,
    durationAmount: durationAmountLent,
    dailyInterestAmount: dailyInterestAmountLent,
    outstandingInterestAmount: outstandingInterestAmountLent,
    sumMultiPrincipalAPR: sumMultiPrincipalAPRLent,
    sumPrincipalInUsd: sumPrincipalInUsdLent,
    repaidXtermTotal,
    repaidPrincipalTotal,
  } = lentLoans.reduce(
    (agg, loan) => {
      let { repaidCount, activeCount, foreclosedCount } = agg;
      const ltv = Number(
        calculateLtv(
          loan.loanRequest.principal,
          loan.loanRequest.loanTokenOwner.collectionToken.floorPrice,
          loan.loanRequest.token.symbol
        )
      );

      if (loan.status === "paid") {
        repaidCount++;
      } else if (loan.status === "active") {
        if (moment(loan.endDate).isAfter(moment())) {
          activeCount++;
        } else {
          foreclosedCount++;
        }
      } else if (loan.status === "foreclosed") {
        foreclosedCount++;
      }
      const principalInUsd = loan.loanRequest.principal * loan.usdPrice;
      const correctedAPR = loan.loanRequest.apr / 100;
      const multiPrincipalAPR = principalInUsd * correctedAPR;

      const dailyInterest =
        loan.status === "active" ? multiPrincipalAPR / 365 : 0;

      const daysSinceCreated = moment().diff(loan.createdAt, "days");

      const outstandingInterest =
        loan.status === "active" ? dailyInterest * daysSinceCreated : 0;

      return {
        lentAmountInUsd: agg.lentAmountInUsd + principalInUsd,
        earnedAmountInUsd:
          agg.earnedAmountInUsd + loan.usdPrice * loan.loanRequest.interestRate,
        activeCount,
        foreclosedCount,
        repaidCount,
        ltvAmount: ltv + agg.ltvAmount,
        durationAmount: agg.durationAmount + loan.loanRequest.term,
        dailyInterestAmount: agg.dailyInterestAmount + dailyInterest,
        outstandingInterestAmount:
          agg.outstandingInterestAmount + outstandingInterest,
        sumMultiPrincipalAPR: agg.sumMultiPrincipalAPR + multiPrincipalAPR,
        sumPrincipalInUsd: agg.sumPrincipalInUsd + principalInUsd,
        repaidXtermTotal:
          agg.repaidXtermTotal +
          (loan.status === "paid"
            ? (loan.loanRequest.interestRate * 365) / loan.loanRequest.term
            : 0),
        repaidPrincipalTotal:
          agg.repaidPrincipalTotal +
          (loan.status === "paid" ? Number(loan.loanRequest.principal) : 0),
      };
    },
    {
      lentAmountInUsd: 0,
      earnedAmountInUsd: 0,
      activeCount: 0,
      foreclosedCount: 0,
      repaidCount: 0,
      ltvAmount: 0,
      durationAmount: 0,
      dailyInterestAmount: 0,
      outstandingInterestAmount: 0,
      sumMultiPrincipalAPR: 0,
      repaidXtermTotal: 0,
      sumPrincipalInUsd: 0,
      repaidPrincipalTotal: 0,
    }
  );

  const avgLtvLent = ltvAmountLent / lentLoans.length || 0;
  const avgDuration = durationAmountLent / lentLoans.length || 0;
  const nettyScore = Math.round(
    (borrowedStats.repaidCount * 100) /
      (borrowedStats.repaidCount + borrowedStats.foreclosedCount)
  );

  const outstandingWavgApr =
    sumMultiPrincipalAPRLent / sumPrincipalInUsdLent || 0;

  const realizedWavgApr = repaidXtermTotal / repaidPrincipalTotal || 0;

  res.status(200).send({
    ...borrowedStats,
    lent,
    borrowed: borrowedAmountInUsd,
    interestPaidAmount: interestPaidAmountInUsd,
    earnedAmount: earnedAmountInUsd,
    repaymentRate:
      (borrowedStats.repaidCount /
        (borrowedStats.repaidCount + borrowedStats.foreclosedCount)) *
      100,
    nettyScore,
    activeLentCount,
    totalLentCount: lentLoans.length,
    foreclosedLentCount,
    defaultLentRate:
      (foreclosedLentCount / (repaidLentCount + foreclosedLentCount)) * 100 ||
      0,
    avgLtvLent,
    avgDuration,
    dailyInterestAmountLent,
    outstandingWavgApr,
    realizedWavgApr,
    outstandingInterestAmountLent,
  });
};

exports.lentLoans = async (req, res) => {
  try {
    const {
      query: { address, sort, dir, searchTerm },
      userId,
    } = req;
    if (!address) return null;
    const { result } = await getPromissoryContractNFTsByWallet(address);

    const loans = await Loan.findAll({
      where: {
        status: {
          [Op.not]: "not-active",
        },
        [Op.or]: [
          {
            NWPN: {
              [Op.in]: result?.map(({ token_id }) => token_id),
            },
          },
          {
            lenderAddress: address,
          },
        ],
        ...(searchTerm && {
          "$loanRequest.loanTokenOwner.collectionName$": {
            [Op.like]: `${searchTerm}%`,
          },
        }),
        lenderUserId: userId,
      },
      include: {
        model: LoanRequest,
        include: [
          {
            model: LoanTokenOwner,
            attributes: [
              "collectionName",
              "collectionAddress",
              "image",
              "collectionId",
            ],
            include: [
              {
                model: Collection,
                as: "collectionToken",
                attributes: ["floorPrice", "address", "id"],
              },
            ],
          },
          {
            model: Token,
          },
        ],
      },
      order: [
        [
          literal(`CASE 
            WHEN \`loan\`.\`status\` = 'active' AND \`loan\`.\`endDate\` > NOW() THEN 0 
            ELSE 1 
          END`), 
          'ASC'
        ],
        ...(sort && dir ? [[literal(`\`${sort}\``), dir]] : []),
      ],
    });

    if (res) {
      await setFloorPrices(
        loans.map((loan) => {
          const floorPrice =
            loan.dataValues.loanRequest.loanTokenOwner.collectionToken
              ?.floorPrice || 0;

          loan.dataValues.loanRequest.loanTokenOwner.dataValues.floorPrice =
            floorPrice;
          return loan.dataValues.loanRequest.loanTokenOwner.dataValues;
        }),
        "collectionAddress",
        async (loan) => {
          const floorPrice = loan.floorPrice;
          loan.collectionToken.floorPrice = floorPrice;
          loan.collectionToken.save();
        }
      );
    }

    return res ? res.status(200).send(loans) : loans;
  } catch (e) {
    console.log(e);
    if (res) {
      return res.status(500).send({ error: e.message });
    } else {
      throw e;
    }
  }
};

exports.borrowedLoans = async (req, res) => {
  try {
    const {
      query: { address, sort, dir, searchTerm },
      userId,
    } = req;

    const loans = await borrowedLoansRepository({
      address,
      sort,
      dir,
      searchTerm,
      userId,
    });

    await setFloorPrices(
      loans.map((loan) => {
        if(loan.dataValues.loanRequest.loanTokenOwner.collectionToken) {
          const floorPrice =
            loan.dataValues.loanRequest.loanTokenOwner.collectionToken.floorPrice;
          loan.dataValues.loanRequest.loanTokenOwner.dataValues.floorPrice =
            floorPrice;
        }

        return loan.dataValues.loanRequest.loanTokenOwner.dataValues;
      }),
      "collectionAddress",
      async (loan) => {
        const floorPrice = loan.floorPrice;
        loan.collectionToken.floorPrice = floorPrice;
        await loan.collectionToken.save();
      }
    );

    return res.status(200).send(loans);
  } catch (e) {
    console.error({ e });

    res.status(404).send(e.message);
  }
};
