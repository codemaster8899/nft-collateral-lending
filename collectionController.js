const { Op, literal, fn, col } = require("sequelize");
const {
  loanRequests: LoanRequest,
  users: User,
  loanTokenOwner: LoanTokenOwner,
  loan: Loan,
  collection: Collection,
  token: Token,
} = require("../models");
const {
  generateAttrbiutesForNettyScore,
  genrateNettyScoreRelation,
  getCorrectCol,
} = require("../utils/nettyscore");
const { setFloorPrices } = require("../utils/setFloorPrices");
const { useConversion } = require("../utils/calculateCryptoSummary");

exports.findOne = async (req, res) => {
  const { collectionAddress } = req.params;

  const { offerSort, activeLoanSort, activeLoanDir, offerDir } = req.query;

  const openOffers = await LoanRequest.findAll({
    where: {
      tokenId: null,
      "$collection.address$": collectionAddress,
      expiryDate: {
        [Op.gt]: new Date(),
      },
    },
    include: [
      {
        model: Collection,
      },
      {
        model: User,
        required: false,
        attributes: [
          "name",
          "id",
          "profile_picture",
          generateAttrbiutesForNettyScore("user"),
        ],
        include: genrateNettyScoreRelation(),
      },
      {
        model: Token,
      },
    ],
    ...(offerSort &&
      offerDir && { order: [literal(`\`${offerSort}\` ${offerDir}`)] }),
    group: ["loanRequest.id"],
  });

  const activeLoans = await Collection.findOne({
    where: {
      address: collectionAddress,
    },
    include: [
      {
        model: LoanTokenOwner,
        as: "collectionToken",
        required: true,
        include: [
          {
            model: Loan,
            required: true,
            as: "activeTokenOwner",
            where: {
              status: "active",
              endDate: {
                [Op.gt]: new Date(),
              },
            },
            include: [
              {
                model: LoanRequest,
                include: [
                  {
                    model: Token,
                  },
                ],
                required: true,
              },
            ],
          },
          {
            model: User,
            required: true,
            as: "borrower",
            attributes: [
              "id",
              "profile_picture",
              "name",
              generateAttrbiutesForNettyScore("collectionToken.borrower"),
            ],
            include: genrateNettyScoreRelation(),
          },
        ],
      },
    ],
    ...(activeLoanSort &&
      activeLoanDir && {
        order: [literal(`\`${activeLoanSort}\` ${activeLoanDir}`)],
      }),
    group: ["collectionToken.tokenId", "collectionToken.activeTokenOwner.id"],
    subQuery: false,
  });

  return res.status(200).send({ activeLoans, openOffers });
};

exports.findAll = async (req, res) => {
  try {
    const { search, sort, dir, select, limit = 20, page = 1 } = req.query;
    const where = {};

    if (search) {
      where.name = {
        [Op.like]: `%${search}%`,
      };
    }

    if (select) {
      const collections = await Collection.findAll({
        attributes: [[fn("DISTINCT", col(select)), select]],
        where,
      });

      return res.status(200).send(collections);
    }

    const collectionOffers = await Collection.findAndCountAll({
      attributes: {
        include: [
          [fn("COUNT", col("loanRequests.id")), "activeOffersCount"],
          [
            literal(
              `JSON_ARRAYAGG(json_object('principal',${getCorrectCol(
                "loanRequests.principal"
              )},'currency',${getCorrectCol(
                "loanRequests.token.symbol"
              )},'term',${getCorrectCol(
                "loanRequests.term"
              )},'apr',${getCorrectCol(
                "loanRequests.apr"
              )},'id',${getCorrectCol("loanRequests.id")}))`
            ),
            "offers",
          ],
        ],
      },
      where,
      include: [
        {
          model: LoanRequest,
          where: {
            expiryDate: {
              [Op.gt]: new Date(),
            },
            tokenId: null,
          },
          include: [
            {
              model: Token,
            },
          ],
          attributes: [],
          required: false,
          order: [["principal", "ASC"]],
        },
      ],
      // distinct: true,
      offset: (page - 1) * parseInt(limit),
      limit: parseInt(limit),
      subQuery: false,
      order:
        sort && dir
          ? [[sort, dir]]
          : [
              ["activeOffersCount", "DESC"],
              ["name", "ASC"],
            ],
      group: ["collection.id"],
    });

    try {
      await setFloorPrices(collectionOffers.rows, "address");
    } catch (e) {
      console.error(e);
    }

    const tokens = await Token.findAll({
      attributes: ["symbol"],
      raw: true,
      where: {
        symbol: {
          [Op.not]: "NW",
        },
      },
    });

    const { convertCurrency } = await useConversion({ tokens, symbol: "USD" });

    collectionOffers.rows.forEach((collection) => {
      const maxCollectionOffer = JSON.parse(collection.dataValues.offers)
        .filter(({ id }) => !!id)
        .reduce((acc, curr) => {
          const amountInUsd = convertCurrency(curr.currency, curr.principal);

          if (acc === null || amountInUsd > acc.amountInUsd) {
            return { ...curr, amountInUsd };
          }

          return acc;
        }, null);

      collection.dataValues.maxCollectionOffer = maxCollectionOffer;

      delete collection.dataValues.offers;
    });

    return res.status(200).send({
      collectionOffers: collectionOffers.rows,
      total: collectionOffers.count.length,
    });
  } catch (e) {
    return res.status(400).send(e.message);
  }
};
